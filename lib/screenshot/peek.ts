"use client";

// 用户主动「让她看一眼我现在的屏幕」。
//
// 与查岗（checkin-engine）的分工：
//   · 查岗是**角色**想看你，所以要浮层审批、要占额度、要总开关；
//   · 这里是**你**主动给看，点这一下本身就是同意，不需要再审一遍，
//     也不该被「角色能不能查岗」的开关拦着。
//
// 落地方式和查岗的同意分支完全一致：截一张 → 存进相册 → 以「你发的图片」
// 进私聊 → 触发角色回应。所以对模型来说，这就是一条普通的图片消息，
// 不需要额外教它这是什么。

import { captureScreenshot, hasScreenshotBridge } from "./bridge";
import { findLatestPrivateSession } from "./checkin-engine";
import { loadCharacters } from "../character-storage";
import { pushChatMessage } from "../chat-storage";
import { storeMediaBase64 } from "../media-cache-storage";

export type PeekResult = { ok: true; width: number; height: number } | { ok: false; reason: string };

/**
 * 截一张当前屏幕，作为「我发的图片」送进和这个角色的私聊。
 *
 * 失败时会在聊天里留一条系统消息——用户点完按钮至少要有个交代，
 * 不能点完什么都不发生。
 */
export async function peekScreenToCharacter(characterId: string): Promise<PeekResult> {
  if (!characterId) return { ok: false, reason: "还不知道要发给谁" };
  if (!hasScreenshotBridge()) {
    return { ok: false, reason: "当前 App 版本还不支持截屏，需要更新安卓壳" };
  }
  const sessionId = findLatestPrivateSession(characterId);
  if (!sessionId) {
    return { ok: false, reason: "还没有和 TA 的聊天记录，先聊一句再试" };
  }

  const captured = await captureScreenshot();
  if (!captured.ok) {
    noteFailure(sessionId, captured.reason);
    return { ok: false, reason: captured.reason };
  }

  try {
    const stored = await storeMediaBase64(captured.base64, "image/png");
    const name = loadCharacters().find(c => c.id === characterId)?.name?.trim() || "TA";
    pushChatMessage({
      sessionId,
      role: "user",
      content: "",
      mediaType: "image",
      mediaUrl: stored.ref,
      mediaData: { label: "我现在的屏幕" },
    });
    // 给角色一句旁白，免得它把这张图当成你随手分享的网图。
    pushChatMessage({
      sessionId,
      role: "system",
      content: `[你主动把此刻的手机屏幕给${name}看了一眼]`,
    });
    return { ok: true, width: captured.width, height: captured.height };
  } catch {
    noteFailure(sessionId, "画面拿到了，但没能存进相册");
    return { ok: false, reason: "画面拿到了，但没能存进相册" };
  }
}

function noteFailure(sessionId: string, reason: string): void {
  try {
    pushChatMessage({
      sessionId,
      role: "system",
      content: `[你想让 TA 看一眼屏幕，但没能截到：${reason}]`,
    });
  } catch {
    // 连消息都写不进去时，只能靠调用方的 toast/日志；这里不抛，避免把
    // 「截屏失败」变成「点击就直接报错」。
  }
}
