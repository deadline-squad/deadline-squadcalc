//! End to end: the `squad-cli` binary with a `bvh.bin` written to disk and a request that names it.

use squad_engine::bvh::{BuildOptions, Bvh, Triangle};
use std::io::Write;
use std::process::{Command, Stdio};

fn run_cli(args: &[&str], input: &str) -> (bool, String, String) {
    let mut child = Command::new(env!("CARGO_BIN_EXE_squad-cli"))
        .args(args)
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
    (
        out.status.success(),
        String::from_utf8_lossy(&out.stdout).into_owned(),
        String::from_utf8_lossy(&out.stderr).into_owned(),
    )
}

#[test]
fn the_cli_loads_a_bvh_file_and_reports_the_occluder() {
    let wall: Vec<Triangle> = vec![
        [
            [-50.0, 300.0, -10.0],
            [50.0, 300.0, -10.0],
            [50.0, 300.0, 400.0],
        ],
        [
            [-50.0, 300.0, -10.0],
            [50.0, 300.0, 400.0],
            [-50.0, 300.0, 400.0],
        ],
    ];
    let bvh = Bvh::build(&wall, BuildOptions::default()).unwrap();
    let path = format!("{}/wall.bin", env!("CARGO_TARGET_TMPDIR"));
    std::fs::write(&path, bvh.to_bytes()).unwrap();

    let input = format!(
        r#"{{"weapon_specs":{{"v0":110,"mass":4.1,"drag_coef":0.4}},"pos_gun":[0,0],"pos_target":[0,600,0],
            "environment":{{"z_scale":1,"bvh_buffer_ref":"{path}"}}}}"#
    );
    let (ok, stdout, stderr) = run_cli(&[], &input);
    assert!(ok, "{stderr}");
    let response: serde_json::Value = serde_json::from_str(&stdout).unwrap();
    assert_eq!(response["occlusion_status"], "occluded");
    assert!((response["collision_details"]["point"][1].as_f64().unwrap() - 300.0).abs() < 1e-9);
}

#[test]
fn the_cli_fails_cleanly_on_a_missing_file() {
    let input = r#"{"weapon_specs":{"v0":110},"pos_gun":[0,0],"pos_target":[0,600,0],
        "environment":{"bvh_buffer_ref":"/nonexistent/bvh.bin"}}"#;
    let (ok, stdout, stderr) = run_cli(&[], input);
    assert!(!ok && stdout.is_empty());
    assert!(stderr.contains("bvh.bin"));
}
