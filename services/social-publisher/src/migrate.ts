import { readdir, readFile } from "node:fs/promises";
import { join } from "node:path";
import { pool } from "./db.js";

const dir=join(process.cwd(),"migrations");
const files=(await readdir(dir)).filter(f=>f.endsWith('.sql')).sort();
for(const file of files){
  const sql=await readFile(join(dir,file),"utf8");
  await pool.query(sql);
  console.log(`Applied ${file}`);
}
await pool.end();
