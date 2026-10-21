import { createInterface } from 'node:readline';

export function readRecords(input, receive, failed = error => { throw error; }) {
  return createInterface({ input }).on('error', failed).on('line', line => {
    // Readline also emits an unfinished line at EOF after an interrupted writer.
    if (!input.readableEnded) receive(JSON.parse(line));
  });
}
