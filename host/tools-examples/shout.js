// A script tool: the inputs come in as JSON on stdin; whatever is printed is the answer.
let input = "";
process.stdin.on("data", (d) => (input += d)).on("end", () => {
  const args = JSON.parse(input || "{}");
  console.log(String(args.text || "").toUpperCase() + "!");
});
