package expo.modules.edgeemotion

// Prompts copied verbatim from the authorized MER demo.
object MerPrompts {
  const val system = "你是一个确定性的多模态情绪分类器。请直接完成分类，不要思考，不要输出推理过程、分析、解释、中间步骤或 <think> 标签。最终回复必须且只能是一个允许的小写英文标签。"
  const val user = "请对所提供的视频和音频进行七分类多模态情绪识别。说话内容为中文，请准确理解中文语义，并综合语音语调、音量、语速、停顿、面部表情、眼神和身体动作，判断整个片段中最主要、最明确的情绪。\n只能从以下标签中选择一个：happy, sad, angry, fear, disgust, surprise, neutral。\n标签含义：happy 表示开心、愉悦或兴奋；sad 表示悲伤、低落或难过；angry 表示生气、愤怒或明显不满；fear 表示害怕、紧张、担忧或不安；disgust 表示厌恶、嫌弃、反感或鄙夷；surprise 表示惊讶、意外或震惊；neutral 表示没有明确的正面或负面情绪。\n当不同模态存在冲突时，选择在整个片段中更持续、更明确、可信度更高的情绪。不要仅仅因为面部表情幅度较小、说话较平静或情绪不夸张就默认选择 neutral；只有在语义、语气、表情和动作都没有提供明确情绪证据时，才选择 neutral。\n只输出一个小写英文标签，不要输出标点、解释或任何其他内容。/no_think"
}
