// Frontend view types mirroring what the pipeline writes to src/data/results.json.

export interface ResultVenue {
  slot: number;
  name: string;
  address: string;
  postcode: string;
  mapsUrl: string;
  product: string;
  productName?: string;
  source: string;
  heading?: number;
  fov?: number;
  panoDate?: string;
  bareness: number;
  placement: string;
  qaScore: number;
  regenerated: boolean;
  frontage: string;
  after: string;
  attempts: { source: string; outcome: string; reason?: string }[];
}

export interface SelectionLogEntry {
  name: string;
  address: string;
  postcode: string;
  outcome: string;
  detail: string;
  bareness?: number;
  product?: string;
}

export interface ResultsSummary {
  _status?: string;
  generatedAt: string | null;
  targetCount: number;
  deliveredCount: number;
  venues: ResultVenue[];
  selectionLog: SelectionLogEntry[];
}

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
