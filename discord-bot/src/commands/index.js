import * as test from './test.js';
import * as ticket from './ticket.js';
import * as help from './help.js';

export const commands = new Map([test, ticket, help].map((command) => [command.data.name, command]));
