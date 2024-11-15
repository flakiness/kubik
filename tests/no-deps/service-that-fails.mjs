import { Task } from 'kubik';

Task.init(import.meta);

let i = 0;
setInterval(() => console.log(`iteration ${++i}`), 100);
setTimeout(() => process.exit(7), 500);
Task.done();
