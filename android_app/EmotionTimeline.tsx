import React, { useEffect, useRef, useState } from "react";
import { FlatList, Pressable, StyleSheet, Text, View } from "react-native";
import { STATUS_LABELS, TAG_LABELS, type EmotionFrame, type EmotionTag } from "./emotionHistory";

const TILE_SIZE = 60;
const TILE_STEP = TILE_SIZE + 6;
const COLORS: Record<EmotionTag | "invalid", { backgroundColor: string; color: string }> = {
  positive: { backgroundColor: "#163e33", color: "#86efb5" },
  negative: { backgroundColor: "#482638", color: "#ffabc2" },
  neutral: { backgroundColor: "#123c53", color: "#77ddff" },
  invalid: { backgroundColor: "#293344", color: "#c0cada" },
};
const INVALID_LABELS: Record<string, string> = {
  no_face: "无脸", multiple_faces: "多脸", invalid_crop: "裁剪无效", inference_failed: "失败",
};
const frameKey = (frame: EmotionFrame) => `${frame.sessionId}:${frame.frameId}`;

export function EmotionTimeline({ frames, nowMs, paused }: {
  frames: EmotionFrame[];
  nowMs: number;
  paused: boolean;
}) {
  const list = useRef<FlatList<EmotionFrame>>(null);
  const follow = useRef(true);
  const [following, setFollowing] = useState(true);
  const [selectedKey, setSelectedKey] = useState<string | null>(null);
  const [frozenFrames, setFrozenFrames] = useState<EmotionFrame[] | null>(null);
  const displayFrames = frozenFrames ?? frames;
  const selected = displayFrames.find((frame) => frameKey(frame) === selectedKey) ?? displayFrames[displayFrames.length - 1];
  const latest = displayFrames[displayFrames.length - 1];
  const session = latest?.sessionId;

  const followLatest = () => {
    follow.current = true;
    setFollowing(true);
    setFrozenFrames(null);
    setSelectedKey(null);
    list.current?.scrollToEnd({ animated: false });
  };
  useEffect(() => { followLatest(); }, [session]);
  const scrollToLatest = () => {
    if (follow.current) list.current?.scrollToEnd({ animated: false });
  };
  const inspect = () => {
    if (!frozenFrames) setFrozenFrames(frames);
    follow.current = false;
    setFollowing(false);
  };
  const age = (frame: EmotionFrame) => Math.max(0, (nowMs - frame.timestampMs) / 1000).toFixed(1);

  return (
    <View style={s.window}>
      <View style={s.legend}>
        {(["positive", "negative", "neutral", "invalid"] as const).map((tag) => (
          <View key={tag} style={s.legendItem}>
            <View style={[s.dot, { backgroundColor: COLORS[tag].color }]} />
            <Text style={s.muted}>{tag === "invalid" ? "无效帧" : TAG_LABELS[tag]}</Text>
          </View>
        ))}
      </View>
      <FlatList ref={list} horizontal data={displayFrames} style={s.strip}
        contentContainerStyle={s.stripContent} showsHorizontalScrollIndicator
        nestedScrollEnabled directionalLockEnabled
        keyExtractor={frameKey} extraData={selected && frameKey(selected)}
        initialNumToRender={12} maxToRenderPerBatch={16} windowSize={5}
        getItemLayout={(_, index) => ({ length: TILE_SIZE, offset: 10 + TILE_STEP * index, index })}
        ItemSeparatorComponent={() => <View style={s.separator} />}
        ListFooterComponent={<View style={s.endPadding} />}
        onTouchStart={inspect} onScrollBeginDrag={inspect} onContentSizeChange={scrollToLatest} onLayout={scrollToLatest}
        ListEmptyComponent={<View style={s.empty}><Text style={s.muted}>等待分析帧，tag 将逐格显示</Text></View>}
        renderItem={({ item }) => {
          const color = COLORS[item.tag ?? "invalid"];
          const active = selected != null && frameKey(item) === frameKey(selected);
          const label = item.tag ? TAG_LABELS[item.tag] : (INVALID_LABELS[item.status] ?? "无效");
          return (
            <Pressable accessibilityRole="button" accessibilityState={{ selected: active }}
              accessibilityLabel={`第 ${item.frameId} 帧，${label}，${item.tag ?? "tag=null"}`}
              onPress={() => { inspect(); setSelectedKey(frameKey(item)); }}
              style={[s.tile, { backgroundColor: color.backgroundColor }, active && s.selected]}>
              <Text style={[s.tileLabel, { color: color.color }]}>{label}</Text>
              <Text numberOfLines={1} adjustsFontSizeToFit style={[s.tileTag, { color: color.color }]}>
                {item.tag ?? "tag=null"}
              </Text>
              <Text numberOfLines={1} style={s.tileId}>#{item.frameId}</Text>
            </Pressable>
          );
        }} />
      <View style={s.axis}>
        <Text style={s.muted}>{displayFrames[0] ? `${age(displayFrames[0])} 秒前` : "较早"} → 最新</Text>
        <Pressable accessibilityRole="button" onPress={followLatest} hitSlop={6}>
          <Text style={s.follow}>
            {paused ? (following ? "已暂停 · 窗口保留" : "回到最新") : (following ? "正在跟随最新" : "回到最新 →")}
          </Text>
        </Pressable>
      </View>
      <View style={s.detail}>
        {selected ? <>
          <Text style={s.detailTitle}>
            #{selected.frameId} · {selected.tag ? `${TAG_LABELS[selected.tag]} / ${selected.tag}` : STATUS_LABELS[selected.status] ?? selected.status}
            {selected.confidence != null ? ` · ${(selected.confidence * 100).toFixed(1)}%` : " · tag=null"}
          </Text>
          <Text style={s.muted}>{age(selected)} 秒前 · 单调时间 {(selected.timestampMs / 1000).toFixed(3)}s</Text>
          {!!selected.error && <Text selectable style={s.error}>{selected.error}</Text>}
        </> : <Text style={s.muted}>每格代表一帧原始结果 · 点击方格查看详情</Text>}
      </View>
    </View>
  );
}

const s = StyleSheet.create({
  window: { borderWidth: 1, borderColor: "#2d5874", borderRadius: 12, backgroundColor: "#0b233b", overflow: "hidden" },
  legend: { flexDirection: "row", flexWrap: "wrap", gap: 12, paddingHorizontal: 10, paddingTop: 10, paddingBottom: 9 },
  legendItem: { flexDirection: "row", alignItems: "center", gap: 4 },
  dot: { width: 7, height: 7, borderRadius: 2 },
  muted: { color: "#9ab2ce", fontSize: 10 },
  strip: { height: TILE_SIZE + 8, flexGrow: 0 },
  stripContent: { paddingLeft: 10, paddingBottom: 8 },
  separator: { width: 6 },
  endPadding: { width: 10 },
  tile: { width: TILE_SIZE, height: TILE_SIZE, borderWidth: 2, borderColor: "transparent", borderRadius: 5, alignItems: "center", justifyContent: "center", gap: 2 },
  selected: { borderColor: "#e6f7ff" },
  tileLabel: { fontSize: 15, fontWeight: "700" },
  tileTag: { fontSize: 10, paddingHorizontal: 1 },
  tileId: { color: "#b3c7d9", fontSize: 9 },
  empty: { height: TILE_SIZE, justifyContent: "center" },
  axis: { paddingHorizontal: 10, paddingTop: 3, paddingBottom: 9, flexDirection: "row", flexWrap: "wrap", alignItems: "center", justifyContent: "space-between", gap: 6 },
  follow: { color: "#77ddff", fontSize: 10 },
  detail: { borderTopWidth: 1, borderTopColor: "#23435d", paddingHorizontal: 10, paddingVertical: 8, gap: 3, minHeight: 48 },
  detailTitle: { color: "#e6f0ff", fontSize: 12, fontWeight: "600" },
  error: { color: "#ff9aa4", fontSize: 11 },
});
