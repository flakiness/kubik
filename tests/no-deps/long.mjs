import { Task } from 'kubik';

Task.init(import.meta);

for (let i = 1; i <= 100; ++i) {
  console.log(`Iteration: ${i} ${new Date()}`);
}
