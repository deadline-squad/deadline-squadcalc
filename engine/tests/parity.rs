//! Parity of the Rust solver with SquadCalc's JavaScript solver (`src/js/squadFiringSolution.js`) over the grid
//! of `tools/direct_fire/compare.py`: every shell of every weapon with a `ballistics` name, 15 distances x 9
//! heights and 18 cases around the maximum range. Needs `node` (v22+); the JS side is
//! `tools/js/reference.mjs`, which runs the real `Weapon` and `SquadFiringSolution` of the checkout.

use serde_json::Value;
use squad_engine::weapon::Weapon;
use std::path::PathBuf;
use std::process::Command;

const TOLERANCE_DEG: f64 = 1e-9;
const TOLERANCE_SEC: f64 = 1e-9;
/// Times of flight above 10 s (near-vertical high arcs of close targets, 40-140 s) are held to this fraction
/// instead: the time is `ahead / (v cos(theta))`, which changes by about 5e3 s per radian near 89 degrees, so
/// the 4e-13 rad the two root searches differ by (different libm `sin`/`cos`) is already ~10 ns.
const TOLERANCE_LONG_FLIGHT: f64 = 3e-10;

fn number(v: &Value) -> f64 {
    v.as_f64().unwrap_or(f64::NAN)
}

/// Whether two values agree: both NaN, or within `tolerance` (absolute).
fn agree(rust: f64, js: f64, tolerance: f64) -> bool {
    if rust.is_nan() || js.is_nan() {
        return rust.is_nan() && js.is_nan();
    }
    (rust - js).abs() <= tolerance
}

#[test]
fn rust_solver_matches_the_javascript_solver() {
    let engine = PathBuf::from(env!("CARGO_MANIFEST_DIR"));
    let checkout = engine.parent().unwrap();
    let output = Command::new("node")
        .current_dir(engine.join("tools/js"))
        .args(["--import", "./hooks.mjs", "reference.mjs"])
        .arg(checkout)
        .output()
        .expect("node must be installed");
    assert!(
        output.status.success(),
        "{}",
        String::from_utf8_lossy(&output.stderr)
    );
    let reference: Value = serde_json::from_slice(&output.stdout).unwrap();

    let weapons: Vec<Weapon> = reference["specs"]
        .as_array()
        .unwrap()
        .iter()
        .map(|spec| serde_json::from_value(spec["params"].clone()).unwrap())
        .collect();
    let max_ranges: Vec<f64> = weapons.iter().map(Weapon::max_distance).collect();

    let rows = reference["rows"].as_array().unwrap();
    let mut mismatches = Vec::new();
    let mut worst_deg = 0.0f64;
    let mut worst_sec = 0.0f64;
    let mut worst_short_sec = 0.0f64;
    let mut checked = 0usize;
    for row in rows {
        let spec = row["spec"].as_u64().unwrap() as usize;
        let weapon = &weapons[spec];
        let (distance, height) = (number(&row["distance"]), number(&row["height"]));
        let solution = weapon.solve(distance, height);

        let degrees = [
            ("low", solution.low.elevation_deg, number(&row["low"])),
            ("high", solution.high.elevation_deg, number(&row["high"])),
            ("sight", solution.sight_angle_deg, number(&row["sight"])),
        ];
        let seconds = [
            (
                "tofLow",
                solution.low.time_of_flight,
                number(&row["tofLow"]),
            ),
            (
                "tofHigh",
                solution.high.time_of_flight,
                number(&row["tofHigh"]),
            ),
            ("hold", solution.hold_time, number(&row["hold"])),
        ];
        for (name, rust, js) in degrees {
            checked += 1;
            if !agree(rust, js, TOLERANCE_DEG) {
                mismatches.push(format!(
                    "{} {name} d={distance} h={height}: rust {rust} js {js}",
                    spec
                ));
            } else if !rust.is_nan() {
                worst_deg = worst_deg.max((rust - js).abs());
            }
        }
        for (name, rust, js) in seconds {
            checked += 1;
            // The JS keeps the time of flight of an arc it blanked out (lifespan, or out of range of the
            // weapon's elevations) while the elevation is NaN; the comparison is on what the JS reports
            let tolerance = TOLERANCE_SEC.max(TOLERANCE_LONG_FLIGHT * js.abs());
            if !agree(rust, js, tolerance) {
                mismatches.push(format!(
                    "{} {name} d={distance} h={height}: rust {rust} js {js}",
                    spec
                ));
            } else if rust.is_finite() {
                worst_sec = worst_sec.max((rust - js).abs());
                if js.abs() <= 10.0 {
                    worst_short_sec = worst_short_sec.max((rust - js).abs());
                }
            }
        }
    }
    for (spec, max) in max_ranges.iter().enumerate() {
        let js = number(
            &rows
                .iter()
                .find(|r| r["spec"].as_u64() == Some(spec as u64))
                .unwrap()["max"],
        );
        checked += 1;
        if !agree(*max, js, 1e-9 * js.abs().max(1.0)) {
            mismatches.push(format!("{spec} max range: rust {max} js {js}"));
        }
    }

    println!(
        "parity: {} shells, {} cases, {checked} values compared, {} mismatches, worst {worst_deg:e} deg, {worst_sec:e} s ({worst_short_sec:e} s under 10 s)",
        weapons.len(),
        rows.len(),
        mismatches.len()
    );
    assert!(
        mismatches.is_empty(),
        "{} mismatches, first: {:#?}",
        mismatches.len(),
        &mismatches[..mismatches.len().min(15)]
    );
}
