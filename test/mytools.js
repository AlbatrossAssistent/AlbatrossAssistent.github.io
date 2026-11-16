// Test of the PC's own tools (host/mytools.js): tools from files, tools made on the website, and the rules that keep the website
// from running programs or reaching the home network. Uses a made-up MCP server; needs no network.
//   node test/mytools.js
const fs = require("fs"), os = require("os"), path = require("path");
const dir = fs.mkdtempSync(path.join(os.tmpdir(), "albatross-tools-"));
process.env.ALBATROSS_TOOLS = dir;
const M = require("../host/mytools.js");

fs.writeFileSync(path.join(dir, "fakemcp.js"), `let b="";process.stdin.on("data",d=>{b+=d;let i;while((i=b.indexOf(String.fromCharCode(10)))>=0){const l=b.slice(0,i);b=b.slice(i+1);if(!l.trim())continue;const m=JSON.parse(l);
const ok=r=>process.stdout.write(JSON.stringify({jsonrpc:"2.0",id:m.id,result:r})+String.fromCharCode(10));
if(m.method==="initialize")ok({protocolVersion:"2024-11-05",capabilities:{tools:{}},serverInfo:{name:"fake",version:"1"}});
else if(m.method==="tools/list")ok({tools:[{name:"add",description:"Adds",inputSchema:{type:"object",properties:{a:{type:"number"},b:{type:"number"}},required:["a","b"]}},{name:"fail",description:"Fails",inputSchema:{type:"object"}}]});
else if(m.method==="tools/call")m.params.name==="add"?ok({content:[{type:"text",text:String(m.params.arguments.a+m.params.arguments.b)}]}):ok({isError:true,content:[{type:"text",text:"nope"}]});}});`);
fs.writeFileSync(path.join(dir, "mcp.json"), JSON.stringify({ servers: { "Fake Srv": { command: "node", args: [path.join(dir, "fakemcp.js").split(path.sep).join("/")] } } }));
fs.writeFileSync(path.join(dir, "shout.js"), `let s="";process.stdin.on("data",d=>s+=d).on("end",()=>{const a=JSON.parse(s);if(a.boom){console.error("bad thing");process.exit(3)}console.log(String(a.text).toUpperCase()+"!")});`);
fs.writeFileSync(path.join(dir, "shout.json"), JSON.stringify({ name: "shout", description: "Shouts", kind: "script", file: "shout.js", params: [{ name: "text", type: "string", required: true }, { name: "boom", type: "boolean" }] }));

const bad = [];
const expect = (name, ok, info) => { if (!ok) bad.push(name + (info !== undefined ? " " + JSON.stringify(info) : "")); };
const call = async (p, o) => { try { const [s, out] = await M.handle("POST", "/agent/mytools/" + p, JSON.stringify(o || {}), () => {}); return { s, ...out }; } catch (e) { return { threw: e.message }; } };

(async () => {
  let l = await call("list");
  for (let i = 0; i < 20 && l.servers.some((s) => s.state === "starting"); i++) l = await call("list");
  const names = l.tools.map((t) => t.name).sort().join();
  expect("list", names === "pc_fake_srv_add,pc_fake_srv_fail,pc_shout", names);
  expect("schema", JSON.stringify(l.tools.find((t) => t.name === "pc_shout").schema.required) === '["text"]');
  expect("script", (await call("run", { name: "pc_shout", args: { text: "hi" } })).result === "HI!");
  expect("script fails", /bad thing/.test((await call("run", { name: "pc_shout", args: { text: "x", boom: true } })).threw || ""));
  expect("mcp", (await call("run", { name: "pc_fake_srv_add", args: { a: 2, b: 40 } })).result === "42");
  expect("mcp error", (await call("run", { name: "pc_fake_srv_fail", args: {} })).threw === "nope");
  expect("unknown tool", (await call("run", { name: "pc_nope" })).s === 404);
  // made on the website
  expect("save prompt", (await call("save", { tool: { name: "Review It", description: "d", kind: "prompt", text: "Review {{code}} now", params: [{ name: "code" }] } })).ok === true);
  expect("run prompt", (await call("run", { name: "pc_review_it", args: { code: "a+b" } })).result === "Review a+b now");
  expect("no scripts from the website", /only be put in the tools folder/.test((await call("save", { tool: { name: "evil", description: "d", kind: "script", file: "shout.js" } })).threw || ""));
  expect("no http from the website", /https/.test((await call("save", { tool: { name: "a", description: "d", kind: "http", url: "http://example.com/" } })).threw || ""));
  for (const u of ["https://127.0.0.1/x", "https://192.168.1.1/x", "https://10.0.0.5/", "https://[::1]/x", "https://localhost/x"]) expect("no private address " + u, /home network|can't be found/.test((await call("save", { tool: { name: "lan", description: "d", kind: "http", url: u } })).threw || ""), u);
  expect("public address saves", (await call("save", { tool: { name: "wx", description: "d", kind: "http", url: "https://8.8.8.8/{{city}}", params: [{ name: "city" }], headers: { "X-Key": "secret" } } })).ok === true);
  expect("headers hidden", JSON.stringify(await call("get", { name: "wx" })).includes("secret") === false);
  await call("save", { tool: { name: "wx", description: "d2", kind: "http", url: "https://8.8.8.8/{{city}}", headers: { "X-Key": "(kept)" } } });
  expect("hidden header kept", fs.readFileSync(path.join(dir, "wx.json"), "utf8").includes('"secret"'));
  expect("can't replace a file tool", (await call("save", { tool: { name: "shout", description: "d", kind: "prompt", text: "x" } })).s === 409);
  expect("can't delete a file tool", (await call("delete", { name: "shout" })).s === 409);
  expect("delete website tool", (await call("delete", { name: "wx" })).ok === true && !fs.existsSync(path.join(dir, "wx.json")));
  // a script can't be reached by editing a website tool's file name
  expect("script path stays in the folder", /must be a .js file/.test((() => { try { M.clean({ name: "s", description: "d", kind: "script", file: "../x.js" }, true); return ""; } catch (e) { return e.message; } })()));
  expect("private addresses", ["127.0.0.1", "10.1.2.3", "172.20.0.1", "192.168.0.5", "169.254.1.1", "::1", "fd00::1", "::ffff:10.0.0.1"].every(M.privateIp) && !["8.8.8.8", "172.32.0.1", "2606:4700::1"].some(M.privateIp));
  M.stopAll(); await new Promise((r) => setTimeout(r, 400));
  try { fs.rmSync(dir, { recursive: true, force: true }); } catch {}      // the stopped server may still hold the folder for a moment (Windows)
  if (bad.length) { console.error("mytools: " + bad.length + " problem(s)\n  " + bad.join("\n  ")); process.exit(1); }
  console.log("mytools: all checks passed"); process.exit(0);
})();
