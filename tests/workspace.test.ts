import { describe, it, expect, beforeAll, afterAll } from "vitest";
import fs from "node:fs";
import path from "node:path";
import { Workspace, WorkspaceError, resolveChatGptPolicy } from "../src/workspace/manager.js";
import { makeTmpDir, cleanup, write } from "./helpers.js";

let root: string;
let outside: string;
let ws: Workspace;
let symlinksReady: boolean;

beforeAll(() => {
  root = makeTmpDir("ws");
  outside = makeTmpDir("outside");
  write(root, "hello.txt", "hello world\n");
  write(root, "src/app.ts", "const x = 1;\n");
  write(root, ".env", "SECRET=topsecret\n");
  write(root, ".env.production", "SECRET=prod\n");
  write(root, ".env.example", "SECRET=changeme\n");
  write(root, "certs/server.pem", "PRIVATE KEY\n");
  write(root, "keys/id_rsa", "PRIVATE KEY\n");
  write(root, "nested/.ssh/config", "Host *\n");
  write(outside, "secret.txt", "outside data\n");
  write(root, ".c2cignore", "private-notes/\n");
  write(root, "private-notes/todo.md", "secret notes\n");
  // symlink pointing outside the workspace (needs symlink privileges, e.g.
  // absent for unprivileged Windows runners — the escape tests then skip)
  symlinksReady = true;
  try {
    fs.symlinkSync(path.join(outside, "secret.txt"), path.join(root, "link-out.txt"));
    fs.symlinkSync(outside, path.join(root, "dir-out"));
  } catch {
    symlinksReady = false;
  }
  ws = new Workspace(root);
});

afterAll(() => {
  cleanup(root);
  cleanup(outside);
});

describe("path containment", () => {
  it("reads a normal relative path", async () => {
    const result = await ws.readFile("hello.txt");
    expect(result.content).toContain("hello world");
  });

  it("rejects ../ traversal", () => {
    expect(() => ws.resolve("../outside-file")).toThrowError(WorkspaceError);
    expect(() => ws.resolve("../../etc/passwd")).toThrow(/PATH_OUTSIDE|outside/i);
    try {
      ws.resolve("a/../../b");
    } catch (error) {
      expect((error as WorkspaceError).code).toBe("PATH_OUTSIDE_WORKSPACE");
    }
  });

  it("rejects absolute paths outside the workspace", () => {
    expect(() => ws.resolve("/etc/passwd")).toThrowError(WorkspaceError);
    expect(() => ws.resolve(outside)).toThrowError(WorkspaceError);
  });

  it("allows absolute paths inside the workspace", () => {
    const resolved = ws.resolve(path.join(root, "hello.txt"));
    expect(resolved.rel).toBe("hello.txt");
  });

  it("rejects windows-style traversal", () => {
    expect(() => ws.resolve("..\\..\\etc\\passwd")).toThrowError(WorkspaceError);
  });

  it("rejects null bytes", () => {
    expect(() => ws.resolve("hello.txt\0.png")).toThrowError(WorkspaceError);
  });

  it("rejects symlinked file escaping the workspace", () => {
    if (!symlinksReady) return; // symlink privilege unavailable
    try {
      ws.resolve("link-out.txt");
      expect.unreachable("should have thrown");
    } catch (error) {
      expect((error as WorkspaceError).code).toBe("PATH_OUTSIDE_WORKSPACE");
    }
  });

  it("rejects paths through a symlinked directory escaping the workspace", () => {
    if (!symlinksReady) return; // symlink privilege unavailable
    try {
      ws.resolve("dir-out/secret.txt");
      expect.unreachable("should have thrown");
    } catch (error) {
      expect((error as WorkspaceError).code).toBe("PATH_OUTSIDE_WORKSPACE");
    }
  });
});

describe("sensitive files", () => {
  const expectDenied = (p: string): void => {
    try {
      ws.resolve(p);
      expect.unreachable(`expected ${p} to be denied`);
    } catch (error) {
      expect((error as WorkspaceError).code).toBe("ACCESS_DENIED_SENSITIVE_FILE");
    }
  };

  it("denies .env and variants", () => {
    expectDenied(".env");
    expectDenied(".env.production");
  });

  it("allows .env.example", () => {
    expect(ws.resolve(".env.example").rel).toBe(".env.example");
  });

  it("denies keys and certificates", () => {
    expectDenied("certs/server.pem");
    expectDenied("keys/id_rsa");
  });

  it("denies .ssh directories anywhere", () => {
    expectDenied("nested/.ssh/config");
  });

  it("honors .c2cignore custom rules", () => {
    expectDenied("private-notes/todo.md");
  });

  it("hides sensitive files from directory listing", async () => {
    const listing = await ws.listDirectory(".", { limit: 500, depth: 2 });
    const paths = listing.entries.map((entry) => entry.path);
    expect(paths).toContain("hello.txt");
    expect(paths).not.toContain(".env");
    expect(paths.some((p) => p.includes("private-notes"))).toBe(false);
  });
});

describe("read_file pagination", () => {
  it("caps unbounded reads at 400 lines and reports the remainder", async () => {
    const big = Array.from({ length: 1000 }, (_, i) => `line ${i + 1}`).join("\n") + "\n";
    write(root, "big.txt", big);
    const result = await ws.readFile("big.txt");
    expect(result.totalLines).toBe(1000);
    expect(result.endLine).toBe(400);
    expect(result.truncated).toBe(true);
    expect(result.remainingLines).toBe(600);
    expect(result.nextStartLine).toBe(401);
  });

  it("returns an explicit range", async () => {
    const result = await ws.readFile("big.txt", { startLine: 500, endLine: 502 });
    expect(result.content).toBe("line 500\nline 501\nline 502");
    expect(result.startLine).toBe(500);
    expect(result.endLine).toBe(502);
  });

  it("denies binary files", async () => {
    fs.writeFileSync(path.join(root, "blob.bin"), Buffer.from([0, 1, 2, 3, 0, 255]));
    await expect(ws.readFile("blob.bin")).rejects.toMatchObject({ code: "BINARY_FILE" });
  });

  it("reports FILE_NOT_FOUND for missing files", async () => {
    await expect(ws.readFile("nope.txt")).rejects.toMatchObject({ code: "FILE_NOT_FOUND" });
  });
});

describe("workspace identity", () => {
  it("has a stable id and name", () => {
    const again = new Workspace(root);
    expect(again.id).toBe(ws.id);
    expect(ws.id).toMatch(/^[a-f0-9]{12}$/);
    expect(ws.name).toBe(path.basename(root));
  });

  it("reads .c2c.json project name", () => {
    const named = makeTmpDir("named");
    write(
      named,
      ".c2c.json",
      JSON.stringify({
        name: "Remi",
        maxIterations: 12,
      })
    );
    const namedWs = new Workspace(named);
    expect(namedWs.name).toBe("Remi");
    expect(namedWs.projectConfig.maxIterations).toBe(12);
    cleanup(named);
  });

});

describe("chatgpt-surface policy", () => {
  it("defaults to chat + auto-reject when .c2c.json has no overrides", () => {
    expect(resolveChatGptPolicy({})).toEqual({ chatgptSurface: "chat", rejectWorkSuggestion: true });
    expect(ws.chatgptPolicy).toEqual({ chatgptSurface: "chat", rejectWorkSuggestion: true });
  });

  it("honors explicit overrides in .c2c.json", () => {
    const dir = makeTmpDir("policy");
    write(dir, ".c2c.json", JSON.stringify({ chatgptSurface: "work", rejectWorkSuggestion: false }));
    const policyWs = new Workspace(dir);
    expect(policyWs.chatgptPolicy).toEqual({ chatgptSurface: "work", rejectWorkSuggestion: false });
    cleanup(dir);
  });

  it("falls back to defaults for garbage values instead of throwing", () => {
    expect(
      resolveChatGptPolicy({ chatgptSurface: "nonsense" as never, rejectWorkSuggestion: "yes" as unknown as boolean })
    ).toEqual({ chatgptSurface: "chat", rejectWorkSuggestion: true });
  });
});

describe("AI_CONTEXT.md bootstrap", () => {
  it("reports absence when the workspace has no AI_CONTEXT.md", () => {
    expect(ws.aiContextInfo()).toEqual({ exists: false, path: "AI_CONTEXT.md" });
  });

  it("reports presence once AI_CONTEXT.md is created, live (not cached at construction)", () => {
    const dir = makeTmpDir("ai-context");
    const liveWs = new Workspace(dir);
    expect(liveWs.aiContextInfo().exists).toBe(false);
    write(dir, "AI_CONTEXT.md", "# Project Context\n");
    expect(liveWs.aiContextInfo()).toEqual({ exists: true, path: "AI_CONTEXT.md" });
    cleanup(dir);
  });
});
