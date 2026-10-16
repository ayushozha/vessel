fn main() {
    let langs = ["Rust", "WASI", "Wasmer"];
    println!("hello from {} (compiled on host, run in a Wasmer sandbox)", langs.join(" + "));
}
