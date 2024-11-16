import { Task } from 'kubik';

Task.init(import.meta, { deps: ['./long.mjs'] });

for (let i = 1; i <= 100; ++i) {
  console.log(`Iteration: ${i} ${new Date()}`);
}
