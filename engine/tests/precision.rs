//! `RTRI1` decoding against a file written by the builder's `build_region.py`, and the precision pass through the CLI.

use flate2::read::GzDecoder;
use squad_engine::precision::{RegionError, RegionFile};
use std::io::{Read, Write};
use std::process::{Command, Stdio};

/// `tests/data/wall.rtri`: encoded by `build_region.encode` (`write_fixture` in `tools/volumetric/tests/test_region.py`)
/// for the square x -20..20, y 250..350 with the margin 0.6 and one triangle across the line of fire at y = 299.8.
const WALL: &[u8] = include_bytes!("data/wall.rtri");

#[test]
fn decodes_a_file_written_by_the_python_builder() {
    let file = RegionFile::from_bytes(WALL).unwrap();
    assert_eq!(file.bounds, [-20.0, 250.0, 20.0, 350.0]);
    assert!((file.margin - 0.6).abs() < 1e-6);
    let expected = [
        [-10.0, 299.8, -10.0],
        [10.0, 299.8, -10.0],
        [0.0, 299.8, 400.0],
    ];
    assert_eq!(file.triangles.len(), 1);
    for (corner, want) in file.triangles[0].iter().zip(expected) {
        for axis in 0..3 {
            assert!((f64::from(corner[axis]) - want[axis]).abs() < 1e-4);
        }
    }
}

#[test]
fn the_rust_writer_and_the_python_builder_agree_on_the_layout() {
    let file = RegionFile::from_bytes(WALL).unwrap();
    let mut python = Vec::new();
    GzDecoder::new(WALL).read_to_end(&mut python).unwrap();
    let mut rust = Vec::new();
    GzDecoder::new(&file.to_bytes()[..])
        .read_to_end(&mut rust)
        .unwrap();
    assert_eq!(rust, python);
}

#[test]
fn damaged_files_are_errors_not_panics() {
    let mut raw = Vec::new();
    GzDecoder::new(WALL).read_to_end(&mut raw).unwrap();
    assert_eq!(
        RegionFile::from_bytes(b"hello"),
        Err(RegionError::NotRegion)
    );
    assert!(matches!(
        RegionFile::from_bytes(&WALL[..WALL.len() - 8]),
        Err(RegionError::Gzip(_))
    ));
    assert_eq!(
        RegionFile::from_bytes(&raw[..raw.len() - 1]),
        Err(RegionError::Truncated)
    );
    let mut inverted = raw;
    inverted[8..12].copy_from_slice(&50.0f32.to_le_bytes());
    assert!(matches!(
        RegionFile::from_bytes(&inverted),
        Err(RegionError::Invalid(_))
    ));
}

/// A gzip `VCOL1` file of a wall: every column of row 600 of a 200 x 1400 grid of 0.5 m columns at (-50, 0), with
/// the heights 0..400 of dz 1 m from z = 0 as one run (as in `tests/voxel.rs`).
fn wall_vcol() -> Vec<u8> {
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
        varint(if column == 0 { 600 * 200 } else { 1 }, &mut raw);
        varint(1, &mut raw);
        varint(0, &mut raw);
        varint(399, &mut raw);
    }
    let mut gzip = flate2::write::GzEncoder::new(Vec::new(), flate2::Compression::default());
    gzip.write_all(&raw).unwrap();
    gzip.finish().unwrap()
}

fn cli_request(environment: &str) -> String {
    format!(
        r#"{{"weapon_specs":{{"v0":110}},"pos_gun":[0,0],"pos_target":[0,600,0],
            "environment":{{{environment}}},"options":{{"arc":"low"}}}}"#
    )
}

fn impact_y(stdout: &str) -> f64 {
    let response: serde_json::Value = serde_json::from_str(stdout).unwrap();
    assert_eq!(response["occlusion_status"], "occluded");
    response["collision_details"]["point"][1].as_f64().unwrap()
}

#[test]
fn the_cli_stops_at_the_region_triangle_instead_of_the_voxel_behind_it() {
    let dir = env!("CARGO_TARGET_TMPDIR");
    let vcol = format!("{dir}/precision-wall.vcol");
    let region = format!("{dir}/precision-wall.rtri");
    std::fs::write(&vcol, wall_vcol()).unwrap();
    std::fs::write(&region, WALL).unwrap();

    let (ok, stdout) = run_cli(&cli_request(&format!(r#""vcol_ref":"{vcol}""#)));
    assert!(ok, "{stdout}");
    assert!((impact_y(&stdout) - 300.0).abs() < 1e-9);

    let (ok, stdout) = run_cli(&cli_request(&format!(
        r#""vcol_ref":"{vcol}","region_ref":"{region}""#
    )));
    assert!(ok, "{stdout}");
    assert!((impact_y(&stdout) - 299.8).abs() < 1e-4);
}

#[test]
fn the_cli_fails_cleanly_on_a_bad_region() {
    let dir = env!("CARGO_TARGET_TMPDIR");
    let vcol = format!("{dir}/precision-wall.vcol");
    std::fs::write(&vcol, wall_vcol()).unwrap();
    let damaged = format!("{dir}/damaged.rtri");
    std::fs::write(&damaged, b"not a region file").unwrap();

    let (ok, message) = run_cli(&cli_request(&format!(
        r#""vcol_ref":"{vcol}","region_ref":"{damaged}""#
    )));
    assert!(!ok);
    assert!(message.contains("not an RTRI1 file"), "{message}");
    let (ok, message) = run_cli(&cli_request(&format!(
        r#""vcol_ref":"{vcol}","region_ref":"/nonexistent/near.rtri""#
    )));
    assert!(!ok);
    assert!(message.contains("region"), "{message}");
    let (ok, message) = run_cli(&cli_request(&format!(r#""region_ref":"{damaged}""#)));
    assert!(!ok);
    assert!(message.contains("needs vcol_ref"), "{message}");
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
