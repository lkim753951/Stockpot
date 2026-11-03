import { t } from '../lib/i18n'
import { Component, useEffect, useState, type ReactNode } from 'react'
import { CopilotKitProvider } from '@copilotkit/react-core/v2'
import { GenerativeUISurface, standardUI, useGenerativeUIRuntime } from '@copilotkit/react-core/v2/generative-ui'
import '@copilotkit/react-core/v2/styles.css'

/** A chart that fails to draw must not take the rest of the screen with it. */
class ViewGuard extends Component<{ children: ReactNode }, { failed: boolean }> {
  state = { failed: false }
  static getDerivedStateFromError() { return { failed: true } }
  render() { return this.state.failed ? <p className="caption">{t("This view couldn't be drawn. The answer above still stands.")}</p> : this.props.children }
}

const THREAD = 'analyst'
const TARGET = 'analyst-answer'

function Surface({ surface }: { surface: any }) {
  const runtime = useGenerativeUIRuntime()
  const [ready, setReady] = useState(false)
  useEffect(() => {
    if (!runtime) return
    runtime.manager.setActiveThread(THREAD)
    runtime.manager.ingest(THREAD, undefined, { ...surface, target: TARGET, status: 'ready', rejected: [] })
    setReady(true)
  }, [runtime, surface])
  return ready ? <GenerativeUISurface id={TARGET} autoScroll={false} /> : null
}

/**
 * Draws an analyst answer with CopilotKit's standard catalog. Loaded only when an answer arrives.
 * Stockpot's own server sends the surface, so no CopilotKit agent runs here.
 */
export default function AnswerView({ surface }: { surface: any }) {
  return (
    <ViewGuard>
      <CopilotKitProvider key={surface.surfaceId} runtimeUrl="/api/copilotkit" generativeUI={{ ui: standardUI }} showDevConsole={false}>
        <Surface surface={surface} />
      </CopilotKitProvider>
    </ViewGuard>
  )
}
