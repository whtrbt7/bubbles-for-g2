import { describe, expect, it } from 'vitest';
import { createDemoApi } from './demo';
import { favOps, MAX_FAVORITES } from './favorites-ui';

describe('favOps', () => {
  it('adds without duplicates and respects the maximum', () => {
    expect(favOps.add(['A'], 'B')).toEqual(['A', 'B']);
    expect(favOps.add(['A'], 'A')).toEqual(['A']);
    const full = Array.from({ length: MAX_FAVORITES }, (_, i) => `P${i}`);
    expect(favOps.add(full, 'New')).toHaveLength(MAX_FAVORITES);
  });

  it('removes by index and moves up without mutating the input', () => {
    const items = ['A', 'B', 'C'];
    expect(favOps.remove(items, 1)).toEqual(['A', 'C']);
    expect(favOps.moveUp(items, 2)).toEqual(['A', 'C', 'B']);
    expect(favOps.moveUp(items, 0)).toEqual(['A', 'B', 'C']);
    expect(items).toEqual(['A', 'B', 'C']);
  });
});

describe('demo favorites', () => {
  it('can be edited and reordered by name', async () => {
    const api = createDemoApi();
    const saved = await api.setFavorites(['Riley Park', 'Jordan Lee', 'Nobody']);
    expect(saved.map((f) => f.name)).toEqual(['Riley Park', 'Jordan Lee']);
    expect((await api.favorites()).map((f) => f.name)).toEqual(['Riley Park', 'Jordan Lee']);
  });
});
