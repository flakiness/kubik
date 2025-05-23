#!/usr/bin/env npx kubik

import path from 'path';
import esbuild from 'esbuild';
import fs from 'fs';
import { Task } from 'kubik';

const { __dirname, $ } = Task.init(import.meta, {
  name: 'kubik',
  watch: [ '../src', '../package.json', '../tsconfig.json', '../tests' ],
});

const outDir = path.join(import.meta.dirname, '..', 'lib');
const srcDir = path.join(import.meta.dirname, '..', 'src');
const typesDir = path.join(import.meta.dirname, '..', 'types');
await fs.promises.rm(outDir, { recursive: true }).catch(e => void e);
await fs.promises.rm(typesDir, { recursive: true }).catch(e => void e);

const { errors } = await esbuild.build({
  color: true,
  entryPoints: [
    path.join(srcDir, '**/*.ts'),
    path.join(srcDir, '**/*.tsx'),
  ],
  outdir: outDir,
  format: 'esm',
  platform: 'node',
  target: ['node22'],
  sourcemap: true,
  bundle: false,
  minify: false,
});

if (!errors.length)
  await $`tsc --pretty -p ..`;

