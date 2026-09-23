import assert from "node:assert/strict";
import test from "node:test";
import { isSameOriginRequest } from "../../src/bootstrap/corsPolicy";

test("同站 Origin 接受本機與 HTTPS 反向代理網址", () => {
  assert.equal(isSameOriginRequest("http://localhost:3303", "http", "localhost:3303"), true);
  assert.equal(isSameOriginRequest("https://demo.example", "https", "demo.example"), true);
  assert.equal(isSameOriginRequest("https://demo.example:443", "https", "demo.example"), true);
});

test("不同站、protocol、port 與無效 Origin 不視為同站", () => {
  assert.equal(isSameOriginRequest("https://other.example", "https", "demo.example"), false);
  assert.equal(isSameOriginRequest("http://demo.example", "https", "demo.example"), false);
  assert.equal(isSameOriginRequest("http://localhost:3304", "http", "localhost:3303"), false);
  assert.equal(isSameOriginRequest("null", "https", "demo.example"), false);
  assert.equal(isSameOriginRequest("https://demo.example", "https", undefined), false);
});
