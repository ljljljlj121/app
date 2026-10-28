import { Audio, Video, ResizeMode, AVPlaybackStatus } from "expo-av";
import React, { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { ActivityIndicator, Pressable, StyleSheet, Text, View } from "react-native";

type Props = {
  uri: string;
  token: string;
  label: string;
  playerRef: React.RefObject<Video | null>;
  audioOnly?: boolean;
  beforePlay: () => Promise<void>;
  onUnavailable?: () => void;
};

const clock = (ms: number) => `${Math.floor(ms / 60000)}:${Math.floor(ms / 1000 % 60).toString().padStart(2, "0")}`;

async function waitForPlayback<T>(operation: Promise<T>): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    return await Promise.race([
      operation,
      new Promise<never>((_, reject) => {
        timer = setTimeout(() => reject(new Error("播放操作超时，请重试加载")), 8000);
      }),
    ]);
  } finally {
    if (timer !== undefined) clearTimeout(timer);
  }
}

export function ReviewMediaPlayer({ uri, token, label, playerRef, audioOnly, beforePlay, onUnavailable }: Props) {
  const [attempt, setAttempt] = useState(0);
  const [loading, setLoading] = useState(true);
  const [actionBusy, setActionBusy] = useState(false);
  const [playback, setPlayback] = useState<AVPlaybackStatus | null>(null);
  const [error, setError] = useState("");
  const [note, setNote] = useState("");
  const wantPlay = useRef(false);
  const mounted = useRef(true);
  // Keep the source stable while progress and button state change.
  const source = useMemo(() => ({
    uri,
    headers: { "X-Upload-Token": token.trim() },
    overrideFileExtensionAndroid: audioOnly ? "wav" : "mp4",
  }), [uri, token, audioOnly]);

  useEffect(() => {
    mounted.current = true;
    return () => { mounted.current = false; wantPlay.current = false; };
  }, []);
  useEffect(() => {
    setPlayback(null);
    setError("");
    setNote("");
    setLoading(true);
  }, [attempt, uri]);
  useEffect(() => {
    if (!loading) return;
    const timer = setTimeout(() => {
      wantPlay.current = false;
      setError("加载超时，请检查网络后点击重试");
      setNote("");
    }, 15000);
    return () => clearTimeout(timer);
  }, [loading, attempt, uri]);

  const reportError = (message: string) => {
    wantPlay.current = false;
    setLoading(false);
    setNote("");
    setError(message || "播放失败，请重试");
    onUnavailable?.();
  };

  const start = useCallback(async (replay: boolean) => {
    const player = playerRef.current;
    if (!player) return;
    await beforePlay();
    if (!mounted.current || playerRef.current !== player || !wantPlay.current) return;
    await Audio.setAudioModeAsync({
      playsInSilentModeIOS: true,
      shouldDuckAndroid: true,
      playThroughEarpieceAndroid: false,
    });
    if (!mounted.current || playerRef.current !== player || !wantPlay.current) return;
    if (replay) await player.setPositionAsync(0);
    if (!mounted.current || playerRef.current !== player || !wantPlay.current) return;
    await player.playAsync();
    wantPlay.current = false;
    if (mounted.current) setNote("");
  }, [beforePlay, playerRef]);

  const pressPlay = async (replay = false) => {
    if (actionBusy) return;
    setActionBusy(true);
    setError("");
    try {
      const status = await waitForPlayback(playerRef.current?.getStatusAsync() ?? Promise.resolve(null));
      if (status?.isLoaded && status.isPlaying && !replay) {
        wantPlay.current = false;
        await waitForPlayback(playerRef.current?.pauseAsync() ?? Promise.resolve(null));
      } else {
        wantPlay.current = true;
        if (!status?.isLoaded) {
          setNote("正在加载，完成后开始播放");
          if (status && "error" in status && status.error) {
            setAttempt((value) => value + 1);
          }
          return;
        }
        const finished = status.didJustFinish || (status.durationMillis !== undefined && status.positionMillis >= status.durationMillis - 100);
        await waitForPlayback(start(replay || finished));
      }
    } catch (e) {
      if (mounted.current) reportError(e instanceof Error ? e.message : "播放失败，请重试");
    } finally {
      if (mounted.current) setActionBusy(false);
    }
  };

  const onLoad = (status: AVPlaybackStatus) => {
    setPlayback(status);
    setLoading(false);
    setError("");
    if (wantPlay.current) {
      setActionBusy(true);
      void waitForPlayback(start(true)).catch((e: unknown) => {
        if (mounted.current) reportError(e instanceof Error ? e.message : "播放失败，请重试");
      }).finally(() => {
        if (mounted.current) setActionBusy(false);
      });
    }
  };
  const loaded = playback?.isLoaded ? playback : null;
  return (
    <View style={styles.panel}>
      <Text style={styles.label}>{label}</Text>
      <Video
        key={`${uri}-${attempt}`}
        ref={playerRef}
        source={source}
        style={audioOnly ? styles.audio : styles.video}
        resizeMode={ResizeMode.CONTAIN}
        useNativeControls={false}
        progressUpdateIntervalMillis={250}
        onLoad={onLoad}
        onError={reportError}
        onPlaybackStatusUpdate={setPlayback}
      />
      <View style={styles.row}>
        <Pressable accessibilityRole="button" disabled={actionBusy} style={styles.button} onPress={() => void pressPlay()}>
          <Text style={styles.buttonText}>{loaded?.isPlaying ? "暂停" : "播放"}</Text>
        </Pressable>
        <Pressable accessibilityRole="button" disabled={actionBusy} style={styles.button} onPress={() => void pressPlay(true)}>
          <Text style={styles.buttonText}>从头播放</Text>
        </Pressable>
        <Pressable accessibilityRole="button" disabled={actionBusy} style={styles.button} onPress={() => { wantPlay.current = false; setAttempt((value) => value + 1); }}>
          <Text style={styles.buttonText}>重试加载</Text>
        </Pressable>
      </View>
      {loading && !error && <ActivityIndicator color="#41d9ed" />}
      <Text style={styles.detail}>{note || (loading ? "正在加载…" : loaded?.isBuffering ? "正在缓冲…" : `${clock(loaded?.positionMillis || 0)} / ${clock(loaded?.durationMillis || 0)}`)}</Text>
      {!!error && <Text style={styles.error}>{error}</Text>}
    </View>
  );
}

const styles = StyleSheet.create({
  panel: { marginTop: 8, backgroundColor: "#10243b", borderRadius: 12, padding: 10 },
  label: { color: "#e2f5ff", fontWeight: "700", marginBottom: 6 },
  video: { width: "100%", height: 300, backgroundColor: "#02070d" },
  audio: { width: "100%", height: 1 },
  row: { flexDirection: "row", gap: 8, marginVertical: 9 },
  button: { flex: 1, backgroundColor: "#1169d8", borderRadius: 8, paddingVertical: 12, alignItems: "center" },
  buttonText: { color: "white", fontWeight: "700", fontSize: 13 },
  detail: { color: "#86a4bd", textAlign: "center", fontSize: 12 },
  error: { color: "#ff9ba5", fontSize: 12, marginTop: 6 },
});
