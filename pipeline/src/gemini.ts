// Thin wrapper around @google/genai for the two things we need:
//  1) structured vision judgements (frontage judge + output QA)  -> JSON
//  2) reference-faithful image compositing ("Nano Banana")       -> PNG buffer
import { GoogleGenAI } from '@google/genai';
import { env, MODELS, assertKey } from './config.js';

let client: GoogleGenAI | null = null;
function ai(): GoogleGenAI {
  assertKey('gemini');
  client ??= new GoogleGenAI({ apiKey: env.geminiKey });
  return client;
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

/**
 * Retry transient errors (503 overloaded, 429 rate-limit). A 429 that is a
 * *billing/tier* failure (free-tier limit 0) is not transient – we surface it
 * immediately with a clear message so the operator knows to enable billing.
 */
async function withRetry<T>(fn: () => Promise<T>, label: string, tries = 4): Promise<T> {
  let last: unknown;
  for (let i = 0; i < tries; i++) {
    try {
      return await fn();
    } catch (err) {
      last = err;
      const msg = (err as Error).message ?? '';
      if (/free_tier.*limit:\s*0|billing details/.test(msg) && /per.?day|limit:\s*0/i.test(msg)) {
        throw new Error(`${label}: Gemini image/model quota is 0 on this key – enable billing on the Gemini project. (${msg.slice(0, 160)})`);
      }
      if (/\b(503|429|overloaded|UNAVAILABLE|high demand)\b/i.test(msg) && i < tries - 1) {
        await sleep(2000 * (i + 1));
        continue;
      }
      throw err;
    }
  }
  throw last;
}

export interface InlineImage {
  mimeType: string;
  /** base64-encoded bytes (no data: prefix). */
  data: string;
}

export function fileToInline(buf: Buffer, mimeType = 'image/png'): InlineImage {
  return { mimeType, data: buf.toString('base64') };
}

function imagePart(img: InlineImage) {
  return { inlineData: { mimeType: img.mimeType, data: img.data } };
}

/**
 * Ask the vision model a question about one or more images and parse a JSON
 * object back. We request JSON explicitly and defensively extract the first
 * {...} block so a stray prose wrapper can't break the run.
 */
export async function visionJSON<T>(prompt: string, images: InlineImage[]): Promise<T> {
  const res = await withRetry(() => ai().models.generateContent({
    model: MODELS.vision,
    contents: [{ role: 'user', parts: [{ text: prompt }, ...images.map(imagePart)] }],
    config: { responseMimeType: 'application/json', temperature: 0.2 },
  }), 'visionJSON');
  const text = res.text ?? '';
  return extractJSON<T>(text);
}

export function extractJSON<T>(text: string): T {
  const trimmed = text.trim();
  try {
    return JSON.parse(trimmed) as T;
  } catch {
    const start = trimmed.indexOf('{');
    const end = trimmed.lastIndexOf('}');
    if (start !== -1 && end > start) {
      return JSON.parse(trimmed.slice(start, end + 1)) as T;
    }
    throw new Error(`Vision model did not return JSON. Got: ${trimmed.slice(0, 200)}`);
  }
}

/**
 * Composite: send the frontage + product reference image(s) + an instruction,
 * and return the generated image bytes. Returns null if the model declined to
 * produce an image (e.g. safety block), so callers can fall back / reject.
 */
export async function composite(
  prompt: string,
  frontage: InlineImage,
  products: InlineImage[],
  aspectRatio?: string,
): Promise<Buffer | null> {
  const res = await withRetry(() => ai().models.generateContent({
    model: MODELS.image,
    contents: [
      {
        role: 'user',
        parts: [{ text: prompt }, imagePart(frontage), ...products.map(imagePart)],
      },
    ],
    // Lock the output aspect ratio to the frontage so the model edits in place
    // rather than re-cropping/recomposing the scene.
    ...(aspectRatio ? { config: { imageConfig: { aspectRatio } } } : {}),
  }), 'composite');
  const parts = res.candidates?.[0]?.content?.parts ?? [];
  for (const p of parts) {
    if (p.inlineData?.data) {
      return Buffer.from(p.inlineData.data, 'base64');
    }
  }
  return null;
}
