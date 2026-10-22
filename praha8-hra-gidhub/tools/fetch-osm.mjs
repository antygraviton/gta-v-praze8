// One-off: node tools/fetch-osm.mjs  (Node 18+). Writes data/praha8.geojson
import { writeFileSync } from 'node:fs';
const q = `[out:json][timeout:300][maxsize:1073741824];
area["name"="Praha 8"]["boundary"="administrative"]["admin_level"~"^(9|10)$"]->.a;
(way(area.a)["building"];
way(area.a)["highway"]["highway"!~"^(proposed|construction|steps|corridor)$"];
way(area.a)["natural"="wood"];way(area.a)["landuse"="forest"];way(area.a)["leisure"="park"];
node(area.a)["natural"="tree"];);out geom;`;
const r = await fetch('https://overpass-api.de/api/interpreter', { method: 'POST', body: 'data=' + encodeURIComponent(q) });
if (!r.ok) throw new Error('Overpass ' + r.status);
const feats = [];
for (const e of (await r.json()).elements) {
  const tags = e.tags || {};
  if (e.type === 'node') { feats.push({ type: 'Feature', properties: tags, geometry: { type: 'Point', coordinates: [e.lon, e.lat] } }); continue; }
  const c = (e.geometry || []).map(p => [+p.lon.toFixed(6), +p.lat.toFixed(6)]);
  if (c.length < 2) continue;
  const closed = c.length > 3 && c[0][0] === c.at(-1)[0] && c[0][1] === c.at(-1)[1];
  const area = tags.building || tags.landuse || tags.natural || tags.leisure;
  feats.push({ type: 'Feature', properties: tags, geometry: closed && area ? { type: 'Polygon', coordinates: [c] } : { type: 'LineString', coordinates: c } });
}
writeFileSync('data/praha8.geojson', JSON.stringify({ type: 'FeatureCollection', features: feats }));
console.log(feats.length, 'features');
