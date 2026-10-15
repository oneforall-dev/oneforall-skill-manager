export type PublishResult = { id: string };
export type IgCredentials = { instagramUserId: string; accessToken: string };
export type TrialReelGraduationStrategy = "MANUAL" | "SS_PERFORMANCE";

type GraphError = { error?: { message?: string; type?: string; code?: number; error_subcode?: number } };
export class InstagramApiError extends Error {
  readonly status?:number;
  readonly publicationOutcome:"safe"|"unknown";
  constructor(message:string,args:{status?:number;publicationOutcome?:"safe"|"unknown"}={}){
    super(message);this.name="InstagramApiError";this.status=args.status;this.publicationOutcome=args.publicationOutcome||"safe";
  }
}
type PublishHooks={beforePublish?:()=>Promise<void>|void};
const base = () => process.env.META_GRAPH_BASE || "https://graph.instagram.com";
const version = () => process.env.META_GRAPH_VERSION || "v24.0";

async function graph<T>(creds: IgCredentials, path: string, method: "GET" | "POST" = "POST", params: Record<string,string|boolean|number|undefined> = {},stage:"safe"|"publish"="safe"): Promise<T> {
  const url = new URL(`${base()}/${version()}/${path}`);
  for (const [k,v] of Object.entries(params)) if (v !== undefined) url.searchParams.set(k, String(v));
  url.searchParams.set("access_token", creds.accessToken);
  let r:Response;
  try{r=await fetch(url,{method});}
  catch(error:any){throw new InstagramApiError(String(error?.message||error),{publicationOutcome:stage==='publish'?'unknown':'safe'});}
  let body:T & GraphError;
  try{body=await r.json() as T & GraphError;}
  catch(error:any){throw new InstagramApiError(`Instagram API returned an unreadable response (${r.status})`,{status:r.status,publicationOutcome:stage==='publish'&&r.ok?'unknown':'safe'});}
  if(!r.ok||body.error){
    const ambiguous=stage==='publish'&&(r.status===429||r.status>=500);
    throw new InstagramApiError(body.error?.message||`Instagram API error ${r.status}`,{status:r.status,publicationOutcome:ambiguous?'unknown':'safe'});
  }
  return body;
}

export async function getProfile(creds: IgCredentials) {
  const profile = await graph<{id?:string;user_id?:string;username?:string;account_type?:string}>(
    creds,
    "me?fields=id,user_id,username,account_type",
    "GET"
  );
  const id = String(profile.user_id || profile.id || creds.instagramUserId);
  return { id, username: profile.username, account_type: profile.account_type };
}
export async function createImageContainer(creds: IgCredentials, imageUrl: string, caption?: string, isCarouselItem = false) {
  return graph<{id:string}>(creds, `${creds.instagramUserId}/media`, "POST", { media_type:"IMAGE", image_url:imageUrl, caption:isCarouselItem?undefined:caption, is_carousel_item:isCarouselItem||undefined });
}
export async function createCarouselContainer(creds: IgCredentials, children: string[], caption?: string) {
  return graph<{id:string}>(creds, `${creds.instagramUserId}/media`, "POST", { media_type:"CAROUSEL", children:children.join(","), caption });
}
export function reelContainerParams(videoUrl: string, caption?: string, shareToFeed = true, coverUrl?: string, trialGraduationStrategy?: TrialReelGraduationStrategy) {
  return {
    media_type:"REELS",
    video_url:videoUrl,
    caption,
    share_to_feed:shareToFeed,
    cover_url:coverUrl,
    trial_params:trialGraduationStrategy?JSON.stringify({graduation_strategy:trialGraduationStrategy}):undefined
  };
}
export async function createReelContainer(creds: IgCredentials, videoUrl: string, caption?: string, shareToFeed = true, coverUrl?: string, trialGraduationStrategy?: TrialReelGraduationStrategy) {
  if(trialGraduationStrategy&&process.env.INSTAGRAM_TRIAL_REELS_ENABLED==="false") throw new Error("TRIAL_REELS_DISABLED: server capability flag is off");
  return graph<{id:string}>(creds, `${creds.instagramUserId}/media`, "POST", reelContainerParams(videoUrl,caption,shareToFeed,coverUrl,trialGraduationStrategy));
}
export async function getContainerStatus(creds: IgCredentials, containerId: string) {
  return graph<{id:string;status_code?:string;status?:string}>(creds, `${containerId}?fields=id,status_code,status`, "GET");
}
export async function waitForContainer(creds: IgCredentials, containerId: string, timeoutMs = 180000) {
  const started = Date.now();
  while (Date.now() - started < timeoutMs) {
    const s = await getContainerStatus(creds, containerId);
    if (s.status_code === "FINISHED") return s;
    if (s.status_code === "ERROR" || s.status_code === "EXPIRED") throw new Error(s.status || `Container ${s.status_code}`);
    await new Promise(r => setTimeout(r, 4000));
  }
  throw new Error("Timed out waiting for Instagram media processing");
}
export async function publishContainer(creds: IgCredentials, containerId: string): Promise<PublishResult> {
  return graph<PublishResult>(creds, `${creds.instagramUserId}/media_publish`, "POST", { creation_id:containerId },"publish");
}
export async function publishImage(creds: IgCredentials, imageUrl: string, caption?: string,hooks:PublishHooks={}) {
  const c = await createImageContainer(creds, imageUrl, caption, false);
  await waitForContainer(creds, c.id);
  await hooks.beforePublish?.();
  return publishContainer(creds, c.id);
}
export async function publishCarousel(creds: IgCredentials, imageUrls: string[], caption?: string,hooks:PublishHooks={}) {
  if (imageUrls.length < 2 || imageUrls.length > 10) throw new Error("Carousel must contain 2 to 10 images");
  const children: string[] = [];
  for (const [index,url] of imageUrls.entries()) {
    try {
      const child = await createImageContainer(creds, url, undefined, true);
      await waitForContainer(creds, child.id);
      children.push(child.id);
    } catch (error:any) {
      throw new Error(`Carousel child ${index + 1} failed: ${String(error?.message || error)}`);
    }
  }
  const parent = await createCarouselContainer(creds, children, caption);
  await waitForContainer(creds, parent.id);
  await hooks.beforePublish?.();
  return publishContainer(creds, parent.id);
}
export async function publishReel(creds: IgCredentials, videoUrl: string, caption?: string, shareToFeed = true, coverUrl?: string,trialGraduationStrategy?:TrialReelGraduationStrategy,hooks:PublishHooks={}) {
  const c = await createReelContainer(creds, videoUrl, caption, shareToFeed, coverUrl,trialGraduationStrategy);
  await waitForContainer(creds, c.id);
  await hooks.beforePublish?.();
  return publishContainer(creds, c.id);
}
