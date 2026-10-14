import { S3Client, type S3ClientConfig } from "@aws-sdk/client-s3";

function required(env:NodeJS.ProcessEnv,name:string){const value=env[name];if(!value) throw new Error(`${name} is required`);return value;}

export function createR2Client(overrides:Partial<S3ClientConfig>={},env:NodeJS.ProcessEnv=process.env){
  return new S3Client({
    region:"auto",
    endpoint:`https://${required(env,"R2_ACCOUNT_ID")}.r2.cloudflarestorage.com`,
    credentials:{accessKeyId:required(env,"R2_ACCESS_KEY_ID"),secretAccessKey:required(env,"R2_SECRET_ACCESS_KEY")},
    ...overrides
  });
}

