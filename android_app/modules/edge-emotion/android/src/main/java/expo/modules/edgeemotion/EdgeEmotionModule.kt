package expo.modules.edgeemotion

import expo.modules.kotlin.modules.Module
import expo.modules.kotlin.modules.ModuleDefinition

class EdgeEmotionModule : Module() {
  override fun definition() = ModuleDefinition {
    Name("EdgeEmotion")
    View(EmotionView::class) {
      Events("onFrames", "onSpeech")
      Prop("speechConfig") { view: EmotionView, value: String -> view.speechConfig = value }
      Prop("paused") { view: EmotionView, value: Boolean -> view.paused = value }
      Prop("front") { view: EmotionView, value: Boolean -> view.front = value }
      Prop("acknowledged") { view: EmotionView, value: String -> view.acknowledged = value }
      OnViewDidUpdateProps { view: EmotionView -> view.update() }
      OnViewDestroys { view: EmotionView -> view.dispose() }
    }
  }
}
