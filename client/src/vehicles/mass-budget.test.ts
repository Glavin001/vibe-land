import { describe, expect, it } from 'vitest';
import { budgetScales, bondScale, massBudget } from './mass-budget.mjs';
import { classes } from './reality.mjs';

const part = (id: string, name: string, kg: number) => ({ id, name, kg });
const kg = (p: { kg: number }) => p.kg;

describe('mass budgets', () => {
  it('masses the monster truck inside its real class, on real wheels', () => {
    const budget = massBudget('monster')!;
    expect(budget.totalKg).toBeGreaterThanOrEqual(classes.monster.massKg[0]);
    expect(budget.totalKg).toBeLessThanOrEqual(classes.monster.massKg[1]);
    expect(budget.wheelKg).toBeGreaterThanOrEqual(classes.monster.wheelKg[0]);
    expect(budget.wheelKg).toBeLessThanOrEqual(classes.monster.wheelKg[1]);
    expect(massBudget('buggy')).toBeNull();
  });

  it('puts each road wheel on its budget and the rest on one factor', () => {
    const parts = [
      ...['Front left', 'Front right', 'Rear left', 'Rear right'].map((c, i) => part(`w${i}`, `${c} wheel assembly`, 200 + i)),
      part('frame', 'Left cage member', 300), part('engine', 'Engine core', 500),
      part('steer', 'Steering wheel assembly', 2),
    ];
    const budget = { totalKg: 3000, wheelKg: 300 };
    const scales = budgetScales(parts, kg, budget);
    const total = parts.reduce((n, p) => n + p.kg * scales.get(p.id)!, 0);
    expect(total).toBeCloseTo(3000, 6);
    for (const w of parts.slice(0, 4)) expect(w.kg * scales.get(w.id)!).toBeCloseTo(300, 6);
    // The steering wheel is not a road wheel.
    expect(scales.get('steer')).toBeCloseTo(scales.get('frame')!, 12);
    expect(scales.get('engine')).toBeCloseTo(1800 / 802, 12);
  });

  it('scales a bond with the mass it joins', () => {
    const mass = new Map([['a', 100], ['b', 300]]), scale = new Map([['a', 2], ['b', 1]]);
    expect(bondScale({ a: 'a', b: 'b' }, (id: string) => mass.get(id)!, (id: string) => scale.get(id)!)).toBeCloseTo(500 / 400, 12);
  });

  it('refuses a car without four road wheels', () => {
    expect(() => budgetScales([part('x', 'Engine core', 10)], kg, { totalKg: 100, wheelKg: 10 })).toThrow(/four road wheels/);
  });
});
