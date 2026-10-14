// Debug helper: run discovery only and print the candidate pool.
// Useful to sanity-check the Places key / query set without spending image quota.
import { discover } from './discover.js';

const venues = await discover();
console.log(`\n${venues.length} candidates:\n`);
for (const v of venues) {
  console.log(`- ${v.name} — ${v.address} (${v.postcode || 'no postcode'})`);
  console.log(`    types: ${v.types.slice(0, 4).join(', ')} | rating ${v.rating ?? '?'} (${v.userRatingCount ?? 0}) | photos ${v.photoNames?.length ?? 0}`);
}
