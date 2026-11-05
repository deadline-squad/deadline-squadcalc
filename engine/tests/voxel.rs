//! `VCOL1` decoding against a file written by the builder's `codec.py`, and the voxel layer through the CLI.

use flate2::read::GzDecoder;
use squad_engine::voxel::{VoxelColumns, VoxelError};
use std::io::{Read, Write};
use std::process::{Command, Stdio};

/// `tests/data/tiny.vcol`: encoded by `codec.encode` for a 40 x 40 grid of 0.5 m columns at (100, -50), dz 0.25
/// from z = -10, with the voxels (column, row, z) below.
const TINY: &[u8] = include_bytes!("data/tiny.vcol");
const TINY_VOXELS: [(u32, u32, u32); 6] = [
    (10, 5, 8),
    (10, 5, 9),
    (10, 5, 11),
    (14, 5, 8),
    (3, 3, 0),
    (39, 39, 4095),
];

#[test]
fn decodes_a_file_written_by_the_python_codec() {
    let columns = VoxelColumns::from_bytes(TINY).unwrap();
    assert_eq!(columns.origin(), [100.0, -50.0, -10.0]);
    assert_eq!(
        (columns.cell(), columns.dz(), columns.size()),
        (0.5, 0.25, (40, 40))
    );
    assert_eq!(columns.voxel_count(), 6);
    assert_eq!(columns.column_count(), 4);
    for (column, row, z) in TINY_VOXELS {
        assert!(columns.is_occupied(column, row, z), "{column} {row} {z}");
    }
    assert!(!columns.is_occupied(10, 5, 10));
    assert_eq!(
        columns,
        VoxelColumns::from_voxels([100.0, -50.0, -10.0], 0.5, 0.25, 40, 40, &TINY_VOXELS).unwrap()
    );
}

#[test]
fn a_decompressed_file_decodes_to_the_same_columns() {
    let mut raw = Vec::new();
    GzDecoder::new(TINY).read_to_end(&mut raw).unwrap();
    assert_eq!(
        VoxelColumns::from_bytes(&raw).unwrap(),
        VoxelColumns::from_bytes(TINY).unwrap()
    );
}

#[test]
fn damaged_files_are_errors_not_panics() {
    let mut raw = Vec::new();
    GzDecoder::new(TINY).read_to_end(&mut raw).unwrap();
    assert_eq!(VoxelColumns::from_bytes(b"hello"), Err(VoxelError::NotVcol));
    assert_eq!(VoxelColumns::from_bytes(&[]), Err(VoxelError::NotVcol));
    assert!(matches!(
        VoxelColumns::from_bytes(&TINY[..TINY.len() - 12]),
        Err(VoxelError::Gzip(_))
    ));
    assert_eq!(
        VoxelColumns::from_bytes(&raw[..raw.len() - 2]),
        Err(VoxelError::Truncated)
    );
    let mut wrong_magic = raw.clone();
    wrong_magic[0] = b'X';
    assert_eq!(
        VoxelColumns::from_bytes(&wrong_magic),
        Err(VoxelError::NotVcol)
    );
    // A column id past the grid: the first varint is the id of the first column
    let mut outside = raw.clone();
    outside[40] = 0x7F;
    outside[41] = 0x7F;
    assert!(matches!(
        VoxelColumns::from_bytes(&outside),
        Err(VoxelError::Invalid(_))
    ));
    // A column count that cannot fit in the data must not allocate
    let mut huge = raw;
    huge[36..40].copy_from_slice(&u32::MAX.to_le_bytes());
    assert_eq!(VoxelColumns::from_bytes(&huge), Err(VoxelError::Truncated));
}

/// A gzip `VCOL1` file (layout of `codec.py`) of a wall: every column of row `wall_row` of a 200 x 1400 grid of
/// 0.5 m columns at (-50, 0), with the heights 0..400 of dz 1 m from z = 0 as one run.
fn wall_file(wall_row: u32) -> Vec<u8> {
    let varint = |mut value: u32, out: &mut Vec<u8>| {
        while value >= 0x80 {
            out.push((value & 0x7F) as u8 | 0x80);
            value >>= 7;
        }
        out.push(value as u8);
    };
    let mut raw = b"VCOL1\0\0\0".to_vec();
    for value in [-50.0f32, 0.0, 0.5, 1.0, 0.0] {
        raw.extend(value.to_le_bytes());
    }
    for value in [200u32, 1400, 200] {
        raw.extend(value.to_le_bytes());
    }
    for column in 0..200u32 {
        // Id delta (the first id is the absolute one), one run starting at 0 and 400 voxels long
        let delta = if column == 0 { wall_row * 200 } else { 1 };
        varint(delta, &mut raw);
        varint(1, &mut raw);
        varint(0, &mut raw);
        varint(399, &mut raw);
    }
    let mut gzip = flate2::write::GzEncoder::new(Vec::new(), flate2::Compression::default());
    gzip.write_all(&raw).unwrap();
    gzip.finish().unwrap()
}

#[test]
fn the_cli_loads_a_vcol_file_and_reports_the_voxel_as_the_impact() {
    let path = format!("{}/wall.vcol", env!("CARGO_TARGET_TMPDIR"));
    std::fs::write(&path, wall_file(600)).unwrap();
    let request = |target_y: u32| {
        format!(
            r#"{{"weapon_specs":{{"v0":110}},"pos_gun":[0,0],"pos_target":[0,{target_y},0],
                "environment":{{"vcol_ref":"{path}"}},"options":{{"arc":"low"}}}}"#
        )
    };
    let (ok, stdout) = run_cli(&request(600));
    assert!(ok, "{stdout}");
    let response: serde_json::Value = serde_json::from_str(&stdout).unwrap();
    assert_eq!(response["occlusion_status"], "occluded");
    let y = response["collision_details"]["point"][1].as_f64().unwrap();
    assert!((y - 300.0).abs() < 1e-9, "impact at y = {y}");

    // A target in front of the wall is not blocked by it
    let (ok, stdout) = run_cli(&request(250));
    assert!(ok, "{stdout}");
    let response: serde_json::Value = serde_json::from_str(&stdout).unwrap();
    assert_eq!(response["occlusion_status"], "clear");
}

#[test]
fn the_cli_fails_cleanly_on_a_missing_or_damaged_vcol_file() {
    let request = |path: &str| {
        format!(
            r#"{{"weapon_specs":{{"v0":110}},"pos_gun":[0,0],"pos_target":[0,300,0],
                "environment":{{"vcol_ref":"{path}"}}}}"#
        )
    };
    let (ok, message) = run_cli(&request("/nonexistent/map.vcol"));
    assert!(!ok);
    assert!(message.contains("vcol"), "{message}");
    let damaged = format!("{}/damaged.vcol", env!("CARGO_TARGET_TMPDIR"));
    std::fs::write(&damaged, b"not a vcol file").unwrap();
    let (ok, message) = run_cli(&request(&damaged));
    assert!(!ok);
    assert!(message.contains("not a VCOL1 file"), "{message}");
}

fn run_cli(input: &str) -> (bool, String) {
    let mut child = Command::new(env!("CARGO_BIN_EXE_squad-cli"))
        .stdin(Stdio::piped())
        .stdout(Stdio::piped())
        .stderr(Stdio::piped())
        .spawn()
        .unwrap();
    child
        .stdin
        .take()
        .unwrap()
        .write_all(input.as_bytes())
        .unwrap();
    let out = child.wait_with_output().unwrap();
    let text = if out.status.success() {
        out.stdout
    } else {
        out.stderr
    };
    (
        out.status.success(),
        String::from_utf8_lossy(&text).into_owned(),
    )
}
