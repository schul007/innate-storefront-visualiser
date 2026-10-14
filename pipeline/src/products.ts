// Loads the client's real product catalog (products/products.json).
import fs from 'node:fs';
import path from 'node:path';
import { PRODUCTS_DIR } from './config.js';
import { fileToInline, type InlineImage } from './gemini.js';

export interface Product {
  id: string;
  name: string;
  image: string;
  form: string;
  material: string;
  planting: string;
  palette: string;
  dimensions_cm: Record<string, number>;
  footprint_cm: { width: number; depth: number };
  best_for: string;
  scale_notes: string;
}

const catalog: Product[] = JSON.parse(
  fs.readFileSync(path.join(PRODUCTS_DIR, 'products.json'), 'utf-8'),
).products;

export function products(): Product[] {
  return catalog;
}

export function productById(id: string): Product | undefined {
  return catalog.find((p) => p.id === id);
}

export function productImage(id: string): InlineImage {
  const p = productById(id);
  if (!p) throw new Error(`unknown product ${id}`);
  const buf = fs.readFileSync(path.join(PRODUCTS_DIR, p.image));
  return fileToInline(buf, 'image/png');
}

/** Compact catalog summary fed to the vision judge for product recommendation. */
export function catalogSummary(): string {
  return catalog
    .map((p) => `- ${p.id} ("${p.name}"): ${p.form}, ${p.material}; ${p.palette}; best for ${p.best_for}. Footprint ~${p.footprint_cm.width}x${p.footprint_cm.depth}cm.`)
    .join('\n');
}
