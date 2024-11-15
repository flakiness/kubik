import { Task } from 'kubik';

Task.init(import.meta, {
  deps: ['b.mjs'],
});

console.log('done - a.mjs');
