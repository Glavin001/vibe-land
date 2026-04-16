export type SplinePoint = { x: number; z: number };

export type SplineData = {
  id: string;
  name?: string;
  points: SplinePoint[];
  closed: boolean;
  interpolation: 'polyline' | 'catmull-rom';
  tension: number; // 0–1, default 0.5, only used for catmull-rom
};
