import { Component, type ReactNode } from 'react'

interface Props {
  label: string
  resetKey: string
  fallback?: ReactNode
  children: ReactNode
}
interface State { hasError: boolean }

export class OptionalAssetBoundary extends Component<Props, State> {
  state: State = { hasError: false }

  static getDerivedStateFromError(): State {
    return { hasError: true }
  }

  componentDidCatch(error: unknown) {
    console.warn('888 Viewer 已跳过加载失败的可选资产:', this.props.label, error)
  }

  componentDidUpdate(prevProps: Props) {
    if (prevProps.resetKey !== this.props.resetKey && this.state.hasError) {
      this.setState({ hasError: false })
    }
  }

  render() {
    return this.state.hasError ? (this.props.fallback ?? null) : this.props.children
  }
}
