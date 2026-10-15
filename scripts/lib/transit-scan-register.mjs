import { register } from 'node:module';
import { pathToFileURL } from 'node:url';
register('./transit-scan-loader.mjs', pathToFileURL('./scripts/lib/'));
