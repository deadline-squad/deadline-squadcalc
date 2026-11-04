//! `squad-cli [request.json]`: reads a JSON request (from the file, or from stdin without an argument),
//! loads the heightmap and BVH files it names and prints the JSON response. Exit status 1 and a message on
//! stderr if the request cannot be answered. See `README.md` for the request format.

use squad_engine::io::{run, Request, Resources};
use std::io::Read;
use std::process::ExitCode;

fn main() -> ExitCode {
    match answer() {
        Ok(json) => {
            println!("{json}");
            ExitCode::SUCCESS
        }
        Err(message) => {
            eprintln!("squad-cli: {message}");
            ExitCode::FAILURE
        }
    }
}

fn answer() -> Result<String, String> {
    let mut text = String::new();
    match std::env::args().nth(1) {
        Some(path) => text = std::fs::read_to_string(&path).map_err(|e| format!("{path}: {e}"))?,
        None => {
            std::io::stdin().read_to_string(&mut text).map_err(|e| e.to_string())?;
        }
    }
    let request: Request = serde_json::from_str(&text).map_err(|e| format!("invalid request: {e}"))?;
    let mut resources = Resources::new();
    resources.load_files(&request).map_err(|e| e.to_string())?;
    let response = run(&request, &resources).map_err(|e| e.to_string())?;
    serde_json::to_string(&response).map_err(|e| e.to_string())
}
