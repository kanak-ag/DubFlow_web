// // cleanTranscript.js — LOCAL CLEANER ONLY (No Gemini, No API)
// // Cleans VTT -> merges duplicates -> outputs clean_<videoId>.json

// const fs = require("fs");
// const fsp = require("fs").promises;
// const path = require("path");

// // ----------------------------
// // Helper: convert HH:MM:SS.ms → seconds
// // ----------------------------
// function toSeconds(t) {
//   const [h, m, s] = t.split(":");
//   return Number(h) * 3600 + Number(m) * 60 + Number(s);
// }

// // ----------------------------
// // Parse VTT into segments
// // ----------------------------
// function parseVTT(vttText) {
//   const lines = vttText.replace(/\r/g, "").split("\n");

//   const segments = [];
//   let i = 0;

//   while (i < lines.length) {
//     const line = lines[i].trim();

//     // Match: 00:00:03.200 --> 00:00:06.900
//     const timeMatch = line.match(
//       /^(\d{2}:\d{2}:\d{2}\.\d{3}) --> (\d{2}:\d{2}:\d{2}\.\d{3})/
//     );

//     if (timeMatch) {
//       const start = toSeconds(timeMatch[1]);
//       const end = toSeconds(timeMatch[2]);

//       let text = "";
//       i++;

//       // Read text until blank line
//       while (i < lines.length && lines[i].trim() !== "") {
//         text += " " + lines[i].trim();
//         i++;
//       }

//       text = text.trim();
//       if (text) {
//         segments.push({
//           rawText: text,
//           start,
//           end,
//           duration: end - start,
//         });
//       }
//     }

//     i++;
//   }

//   return segments;
// }

// // ----------------------------
// // Clean text content
// // ----------------------------
// function cleanText(t) {
//   if (!t) return "";

//   t = t.replace(/\[[^\]]+\]/g, " "); // [Music]
//   t = t.replace(/<[^>]+>/g, " ");    // <c> tags
//   t = t.replace(/\s+/g, " ");        // extra spaces
//   return t.trim();
// }

// // ----------------------------
// // Merge duplicate/incremental segments
// // ----------------------------
// function mergeSegments(segments) {
//   const out = [];

//   for (const seg of segments) {
//     let text = cleanText(seg.rawText);
//     if (!text) continue;

//     const last = out[out.length - 1];

//     if (last) {
//       const A = last.text.toLowerCase();
//       const B = text.toLowerCase();

//       // Merge incremental fragments:
//       // e.g. "wow" -> "wow what" -> "wow what an audience"
//       if (B.includes(A) || A.includes(B)) {
//         last.text = A.length > B.length ? last.text : text;
//         last.end = Math.max(last.end, seg.end);
//         last.duration = last.end - last.start;
//         continue;
//       }
//     }

//     // Otherwise push new segment
//     out.push({
//       text,
//       start: seg.start,
//       end: seg.end,
//       duration: seg.duration,
//     });
//   }

//   return out;
// }

// // ----------------------------
// // Main Function
// // ----------------------------
// async function createCleanTranscript(vttPath, videoId) {
//   const rawVTT = await fsp.readFile(vttPath, "utf8");

//   const parsed = parseVTT(rawVTT);
//   const merged = mergeSegments(parsed);

//   const cleaned = merged.map((x) => ({
//     text: x.text,
//     start: Number(x.start.toFixed(3)),
//     duration: Number(x.duration.toFixed(3)),
//   }));

//   const outPath = path.join(__dirname, `clean_${videoId}.json`);
//   await fsp.writeFile(outPath, JSON.stringify(cleaned, null, 2), "utf8");

//   console.log("✨ Local cleaned transcript saved:", outPath);

//   return outPath;
// }

// module.exports = { createCleanTranscript };
