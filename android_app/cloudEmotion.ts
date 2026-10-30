// Chinese prompts and decoding constraints shared with the verified MER demo.
export const DEFAULT_MER_BASE = "http://183.62.69.210:9005/v1";
export const DEFAULT_MER_MODEL = "/data2/lzh/emo/checkpoint";
export type MerJob = {video: string; audio: string; id: number; kind: string; endedAt?: number; durationMs?: number};
const SYSTEM = "你是一个确定性的多模态情绪分类器。请直接完成分类，不要思考，不要输出推理过程、分析、解释、中间步骤或 <think> 标签。最终回复必须且只能是一个允许的小写英文标签。";
const PROMPT = "请对所提供的视频和音频进行七分类多模态情绪识别。说话内容为中文，请准确理解中文语义，并综合语音语调、音量、语速、停顿、面部表情、眼神和身体动作，判断整个片段中最主要、最明确的情绪。\n只能从以下标签中选择一个：happy, sad, angry, fear, disgust, surprise, neutral。\n标签含义：happy 表示开心、愉悦或兴奋；sad 表示悲伤、低落或难过；angry 表示生气、愤怒或明显不满；fear 表示害怕、紧张、担忧或不安；disgust 表示厌恶、嫌弃、反感或鄙夷；surprise 表示惊讶、意外或震惊；neutral 表示没有明确的正面或负面情绪。\n当不同模态存在冲突时，选择在整个片段中更持续、更明确、可信度更高的情绪。不要仅仅因为面部表情幅度较小、说话较平静或情绪不夸张就默认选择 neutral；只有在语义、语气、表情和动作都没有提供明确情绪证据时，才选择 neutral。\n只输出一个小写英文标签，不要输出标点、解释或任何其他内容。/no_think";
const MODES = [{"chat_template_kwargs": {"enable_thinking": false}, "structured_outputs": {"choice": ["happy", "sad", "angry", "fear", "disgust", "surprise", "neutral"]}, "stop_token_ids": [151643, 151645]}, {"chat_template_kwargs": {"enable_thinking": false}, "guided_choice": ["happy", "sad", "angry", "fear", "disgust", "surprise", "neutral"], "stop_token_ids": [151643, 151645]}, {"guided_choice": ["happy", "sad", "angry", "fear", "disgust", "surprise", "neutral"], "stop_token_ids": [151643, 151645]}, {"chat_template_kwargs": {"enable_thinking": false}, "stop_token_ids": [151643, 151645]}];
const LABELS = new Set(["happy", "sad", "angry", "fear", "disgust", "surprise", "neutral"]);
const acceptedModes = new Map<string, number>();
export async function inferEmotion(job: MerJob, base: string, key: string, model: string, signal: AbortSignal): Promise<string> {
  const endpointKey = `${base}|${model}`;
  const cached = acceptedModes.get(endpointKey);
  const order = cached === undefined ? MODES.map((_, i) => i) : [cached, ...MODES.map((_, i) => i).filter(i => i !== cached)];
  for (const index of order) {
    const extra = MODES[index];
    const response = await fetch(`${base.replace(/\/+$/, "")}/chat/completions`, {
      method: "POST", signal,
      headers: {"Content-Type":"application/json", Authorization:`Bearer ${key}`},
      body: JSON.stringify({model, max_tokens:8, temperature:0, top_p:1, seed:0, ...extra,
        messages:[{role:"system",content:SYSTEM},{role:"user",content:[
          {type:"video_url",video_url:{url:`data:video/mp4;base64,${job.video}`}},
          {type:"audio_url",audio_url:{url:`data:audio/wav;base64,${job.audio}`}},
          {type:"text",text:PROMPT}]}]})
    });
    if (response.status === 400) continue;
    if (!response.ok) throw new Error(`云端接口 HTTP ${response.status}`);
    const data = await response.json();
    const message = data.choices?.[0]?.message;
    const label = String(message?.content || "").trim().toLowerCase().replace(/^```(?:text)?\s*|\s*```$/g, "").replace(/^[\s.,;:!?"']+|[\s.,;:!?"']+$/g, "");
    if (message?.reasoning_content || message?.reasoning || !LABELS.has(label)) throw new Error("模型未返回有效的七分类标签");
    acceptedModes.set(endpointKey, index);
    return label;
  }
  throw new Error("云端拒绝所有受约束请求模式");
}
