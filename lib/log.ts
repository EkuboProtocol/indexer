export function printLog(...any: any[]) {
  console.log(new Date().toISOString(), ...any);
}

export function printError(...any: any[]) {
  console.error(new Date().toISOString(), ...any);
}
