//! Yogurt Team: `squeeze` drops the long quiet stretches of one track before it goes to the speech-to-text service,
//! which bills for every minute sent; the app maps the service's timestamps back with the ranges printed here.
use std::path::Path;

use crate::oggopus::{self, OpusWriter};

fn decode_all(path: &Path, sink: &mut dyn FnMut(&[f32])) -> std::io::Result<()> {
    oggopus::decode(path, |s| { sink(s); true }).map(|_| ()).ok_or_else(|| std::io::Error::new(std::io::ErrorKind::Other, "decode failed"))
}
fn open_writer(path: &Path) -> std::io::Result<OpusWriter> { OpusWriter::create(path, true) }

const RATE: usize = 48_000;
const FRAME: usize = 960; // 20 ms
/// quiet stretches shorter than this stay (pauses between sentences), and this much is kept around speech
const BRIDGE_FRAMES: usize = 100; // 2 s
const PAD_FRAMES: usize = 25; // 0.5 s
/// trimming that saves less than this isn't worth the seams
const MIN_SAVING: f64 = 0.2;

fn db(sum_sq: f64, n: usize) -> f64 { if n == 0 || sum_sq <= 0.0 { -120.0 } else { 10.0 * (sum_sq / n as f64).log10() } }

/// the stretches of a track worth sending for transcription, in 20 ms frames: loud against the track's own quiet
pub fn speech_frames(levels: &[f64]) -> Vec<(usize, usize)> {
    if levels.is_empty() { return vec![] }
    let mut sorted = levels.to_vec();
    sorted.sort_by(|a, b| a.partial_cmp(b).unwrap());
    let floor = sorted[sorted.len() / 10];
    let threshold = (floor + 9.0).max(-55.0);
    let mut runs: Vec<(usize, usize)> = vec![];
    for (i, &l) in levels.iter().enumerate() {
        if l < threshold { continue }
        match runs.last_mut() {
            Some(r) if i - r.1 <= BRIDGE_FRAMES => r.1 = i + 1,
            _ => runs.push((i, i + 1)),
        }
    }
    let mut out: Vec<(usize, usize)> = vec![];
    for (a, b) in runs {
        let (a, b) = (a.saturating_sub(PAD_FRAMES), (b + PAD_FRAMES).min(levels.len()));
        match out.last_mut() { Some(r) if a <= r.1 => r.1 = r.1.max(b), _ => out.push((a, b)) }
    }
    out
}

/// `squeeze --out FILE IN`: writes only IN's speech to FILE and prints the kept stretches as
/// {"ranges":[[startMs,endMs],...],"durationMs":N}; {"skipped":true,...} (no FILE) when trimming would save little
pub fn squeeze(out: &Path, input: &Path) -> Result<(), String> {
    let mut levels: Vec<f64> = vec![];
    let (mut acc, mut n, mut total) = (0f64, 0usize, 0usize);
    decode_all(input, &mut |s: &[f32]| {
        for &x in s {
            acc += (x as f64) * (x as f64); n += 1;
            if n == FRAME { levels.push(db(acc, n)); acc = 0.0; n = 0 }
        }
        total += s.len();
    }).map_err(|e| format!("squeeze: can't read {}: {e}", input.display()))?;
    if n > 0 { levels.push(db(acc, n)) }
    let ms = |frame: usize| ((frame * FRAME).min(total) * 1000 / RATE) as u64;
    let frames = speech_frames(&levels);
    let kept: usize = frames.iter().map(|(a, b)| b - a).sum();
    let duration_ms = (total * 1000 / RATE) as u64;
    if levels.is_empty() || kept as f64 > levels.len() as f64 * (1.0 - MIN_SAVING) {
        println!("{{\"skipped\":true,\"durationMs\":{duration_ms}}}");
        return Ok(())
    }
    let ranges: Vec<(usize, usize)> = frames.iter().map(|&(a, b)| (a * FRAME, (b * FRAME).min(total))).collect();
    let _ = std::fs::remove_file(out);
    let mut w = open_writer(out).map_err(|e| format!("squeeze: can't write {}: {e}", out.display()))?;
    if !ranges.is_empty() {
        let (mut pos, mut ri) = (0usize, 0usize);
        let mut err: Option<String> = None;
        let mut keep: Vec<f32> = Vec::with_capacity(RATE);
        decode_all(input, &mut |s: &[f32]| {
            keep.clear();
            for (k, &x) in s.iter().enumerate() {
                let at = pos + k;
                while ri < ranges.len() && at >= ranges[ri].1 { ri += 1 }
                if ri < ranges.len() && at >= ranges[ri].0 { keep.push(x) }
            }
            pos += s.len();
            if !keep.is_empty() && err.is_none() { if let Err(e) = w.write(&keep) { err = Some(e.to_string()) } }
        }).map_err(|e| format!("squeeze: can't read {}: {e}", input.display()))?;
        if let Some(e) = err { let _ = std::fs::remove_file(out); return Err(format!("squeeze: {e}")) }
    }
    w.finish().map_err(|e| format!("squeeze: {e}"))?;
    let list: Vec<String> = frames.iter().map(|&(a, b)| format!("[{},{}]", ms(a), ms(b))).collect();
    println!("{{\"ranges\":[{}],\"durationMs\":{duration_ms}}}", list.join(","));
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn keeps_speech_with_padding_and_bridges_short_pauses() {
        let mut l = vec![-80.0; 1000];
        for i in 200..300 { l[i] = -20.0 }
        for i in 350..400 { l[i] = -20.0 } // 1 s pause: bridged
        for i in 800..810 { l[i] = -20.0 }
        assert_eq!(speech_frames(&l), vec![(175, 425), (775, 835)]);
    }
    #[test]
    fn silence_keeps_nothing() { assert!(speech_frames(&vec![-120.0; 500]).is_empty()) }
}
