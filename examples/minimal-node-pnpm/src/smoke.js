// Minimal smoke entry: exits non-zero when the library cannot be imported.
import { add, greet } from './index.js';

if (add(1, 2) !== 3 || greet('ci').length === 0) {
  console.error('smoke check failed');
  process.exit(1);
}
console.log('smoke ok');
