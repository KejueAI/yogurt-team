//! Yogurt Team: `mix --out FILE IN...` sums tracks that are already on meeting time (me.ogg, them.ogg) into one
//! Ogg Opus file for listening back. The inputs are left as they are. Each input decodes on its own thread.
use std::collections::VecDeque;
use std::path::{Path, PathBuf};
use std::sync::mpsc::{sync_channel, Receiver};
use std::thread::{self, JoinHandle};

use crate::ogg_opus::{self, OpusWriter};

fn reader(path: PathBuf) -> (Receiver<Vec<f32>>, JoinHandle<bool>) {
    let (tx, rx) = sync_channel::<Vec<f32>>(8);
    let h = thread::spawn(move || ogg_opus::decode(&path, |s| tx.send(s.to_vec()).map_err(|e| std::io::Error::new(std::io::ErrorKind::Other, e.to_string()))).is_ok());
    (rx, h)
}

pub fn mix(out: &Path, inputs: &[PathBuf]) -> Result<(), String> {
    if inputs.is_empty() { return Err("mix: no input files".into()) }
    let (rxs, handles): (Vec<_>, Vec<_>) = inputs.iter().cloned().map(reader).unzip();
    let mut pending: Vec<VecDeque<f32>> = vec![VecDeque::new(); rxs.len()];
    let mut done = vec![false; rxs.len()];
    let _ = std::fs::remove_file(out);
    let mut w = OpusWriter::create(out).map_err(|e| format!("mix: can't write {}: {e}", out.display()))?;
    const CHUNK: usize = 48_000;
    loop {
        // fill every live input to a second ahead, then write what the longest of them has
        for i in 0..rxs.len() {
            while !done[i] && pending[i].len() < CHUNK {
                match rxs[i].recv() { Ok(v) => pending[i].extend(v), Err(_) => done[i] = true }
            }
        }
        let n = (0..rxs.len()).map(|i| if done[i] { pending[i].len() } else { pending[i].len().min(CHUNK) }).max().unwrap_or(0);
        if n == 0 { break }
        let mut buf = vec![0f32; n];
        for p in pending.iter_mut() {
            let take = n.min(p.len());
            for (k, s) in p.drain(..take).enumerate() { buf[k] += s }
        }
        for s in buf.iter_mut() { *s = s.clamp(-1.0, 1.0) }
        w.write(&buf).map_err(|e| format!("mix: {e}"))?;
    }
    w.finish().map_err(|e| format!("mix: {e}"))?;
    for (h, p) in handles.into_iter().zip(inputs) {
        if !h.join().unwrap_or(false) { let _ = std::fs::remove_file(out); return Err(format!("mix: can't read {}", p.display())) }
    }
    Ok(())
}
