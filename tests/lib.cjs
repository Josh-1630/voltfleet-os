// Shared paths for the regression suite. Tests run against the app served at BASE (default http://localhost:8080).
const path = require('path'); const fs = require('fs');
const ROOT = path.resolve(__dirname, '..');
const FIX = path.join(__dirname, 'fixtures');
const OUT = process.env.VF_TEST_OUT || path.join(__dirname, 'out');
fs.mkdirSync(OUT, { recursive: true });
let AXE = null;
try { AXE = require.resolve('axe-core/axe.min.js'); } catch (e) { AXE = process.env.AXE_PATH || null; }
module.exports = { ROOT, FIX, OUT, AXE };
