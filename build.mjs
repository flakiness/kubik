#!/usr/bin/env node

import path from 'path';
import esbuild from 'esbuild';
import fs from 'fs';
import { BuildScript } from '@degulabs/build';

const { __dirname, $ } = await BuildScript.initialize(import.meta, {
  name: 'build & lint',
  watch: [ './src', './package.json' ],
});

const outDir = path.join(__dirname, 'lib');
const srcDir = path.join(__dirname, 'src');
const typesDir = path.join(__dirname, 'types');
await fs.promises.rm(outDir, { recursive: true }).catch(e => void e);
await fs.promises.rm(typesDir, { recursive: true }).catch(e => void e);

const { errors } = await esbuild.build({
  color: true,
  entryPoints: [
    path.join(srcDir, '**/*.ts'),
  ],
  outdir: outDir,
  format: 'esm',
  platform: 'node',
  target: ['node22'],
  sourcemap: false,
  bundle: false,
  minify: false,
});

if (!errors.length)
  await $`tsc --pretty -p .`;
