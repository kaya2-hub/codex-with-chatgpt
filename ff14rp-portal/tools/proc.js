// WindowsのshellでNode spawnする際の引数引用符(空白を含む引数を1つとして渡す)。他OSでは何もしない。
export function shellArgs(args, win = process.platform === "win32") { return win ? args.map(a => (/[\s"]/.test(a) ? `"${String(a).replace(/"/g, '\\"')}"` : a)) : args; }
