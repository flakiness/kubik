import { Task } from 'kubik';

Task.init(import.meta);

console.error('I am failing!');
process.exit(10);
