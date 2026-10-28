import test from "node:test";
import assert from "node:assert/strict";
import { storyContainerParams } from "../../dist/instagram.js";

test("serializes an image Story for the Meta container endpoint",()=>{
  const params=storyContainerParams("https://media.example/story.jpg","image");
  assert.deepEqual(params,{
    media_type:"STORIES",
    image_url:"https://media.example/story.jpg",
    video_url:undefined
  });
});

test("serializes a video Story for the Meta container endpoint",()=>{
  const params=storyContainerParams("https://media.example/story.mp4","video");
  assert.deepEqual(params,{
    media_type:"STORIES",
    image_url:undefined,
    video_url:"https://media.example/story.mp4"
  });
});
