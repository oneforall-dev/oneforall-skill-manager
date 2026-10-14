import { Client, Pool, type PoolClient } from "pg";
const connectionString = process.env.DATABASE_URL;
if (!connectionString) throw new Error("DATABASE_URL is required");

const connectionTimeoutMillis=Number(process.env.DB_CONNECTION_TIMEOUT_MS||5_000);
const queryTimeoutMillis=Number(process.env.DB_QUERY_TIMEOUT_MS||15_000);

export const pool = new Pool({
  connectionString,
  max:Number(process.env.DB_POOL_MAX||10),
  connectionTimeoutMillis,
  idleTimeoutMillis:Number(process.env.DB_IDLE_TIMEOUT_MS||30_000),
  maxLifetimeSeconds:Number(process.env.DB_CONNECTION_MAX_LIFETIME_SECONDS||300),
  query_timeout:queryTimeoutMillis,
  statement_timeout:queryTimeoutMillis,
  keepAlive:true,
  keepAliveInitialDelayMillis:10_000,
  application_name:"oneforall-social-publisher"
});

pool.on("error",error=>console.error("PostgreSQL idle client error",error.message));

export async function checkDatabaseReady(timeoutMs=3_000) {
  const started=Date.now();
  const client=new Client({
    connectionString,
    connectionTimeoutMillis:Math.min(timeoutMs,connectionTimeoutMillis),
    query_timeout:timeoutMs,
    statement_timeout:timeoutMs,
    keepAlive:true,
    application_name:"oneforall-social-publisher-readiness"
  });
  try{
    await client.connect();
    await client.query("SELECT 1");
    return {ok:true,latency_ms:Date.now()-started};
  }catch(error:any){
    return {ok:false,latency_ms:Date.now()-started,error:String(error?.code||error?.message||"database_unavailable")};
  }finally{
    await client.end().catch(()=>undefined);
  }
}

export async function withTx<T>(fn: (client: PoolClient) => Promise<T>): Promise<T> {
  const client = await pool.connect();
  try {
    await client.query("BEGIN");
    const result = await fn(client);
    await client.query("COMMIT");
    return result;
  } catch (e) {
    await client.query("ROLLBACK");
    throw e;
  } finally {
    client.release();
  }
}
