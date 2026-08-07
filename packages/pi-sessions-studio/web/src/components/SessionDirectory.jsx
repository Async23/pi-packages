import { useEffect, useMemo, useRef } from 'react';

function stepLabel(step) {
  return step.isFinal ? '最终回复' : `π 步骤 ${step.index}`;
}

function stepSummary(step) {
  const parts = [];
  if (step.thinkingCount > 0) parts.push(`思考 ${step.thinkingCount}`);
  if (step.toolCount > 0) parts.push(`工具 ${step.toolCount}`);
  return parts.join(' · ');
}

export default function SessionDirectory({ turns, activeEntryId, onNavigate }) {
  const scrollRef = useRef(null);
  const currentRef = useRef(null);

  const location = useMemo(() => {
    for (const turn of turns) {
      if (turn.userEntryId === activeEntryId) return { turn, step: null };
      const step = turn.steps.find((item) => item.entryId === activeEntryId);
      if (step) return { turn, step };
    }
    return turns[0] ? { turn: turns[0], step: null } : { turn: null, step: null };
  }, [turns, activeEntryId]);

  useEffect(() => {
    const container = scrollRef.current;
    const target = currentRef.current;
    if (!container || !target) return;

    const containerRect = container.getBoundingClientRect();
    const targetRect = target.getBoundingClientRect();
    const inset = 10;
    if (targetRect.top < containerRect.top + inset) {
      container.scrollTop -= containerRect.top + inset - targetRect.top;
    } else if (targetRect.bottom > containerRect.bottom - inset) {
      container.scrollTop += targetRect.bottom - containerRect.bottom + inset;
    }
  }, [activeEntryId, location.turn?.id, location.step?.id]);

  if (!turns.length) return null;

  const currentTurn = location.turn;
  const currentStep = location.step;
  const currentText = currentTurn
    ? `第 ${currentTurn.index} 轮${currentStep ? ` · ${stepLabel(currentStep)}` : ''}`
    : '尚未定位';

  return (
    <section className="card session-directory-card" aria-label="阅读与定位">
      <div className="session-directory-head">
        <div>
          <p className="card-title">阅读与定位</p>
          <p className="session-directory-subtitle">会话目录</p>
        </div>
        <span className="session-directory-total">{turns.length} 轮</span>
      </div>

      <div className="session-directory-scroll" ref={scrollRef}>
        <div className="session-directory-tree">
          {turns.map((turn) => {
            const isCurrentTurn = currentTurn?.id === turn.id;
            const turnMeta = `${turn.steps.length} 步${turn.toolCount ? ` · ${turn.toolCount} 工具` : ''}`;
            return (
              <div
                key={turn.id}
                className={`session-directory-turn ${isCurrentTurn ? 'is-current' : ''}`}
                data-directory-turn={turn.index}
                data-step-count={turn.steps.length}
                data-tool-count={turn.toolCount}
              >
                <button
                  type="button"
                  className={`session-directory-row session-directory-turn-row ${isCurrentTurn && !currentStep ? 'is-current' : ''}`}
                  aria-current={isCurrentTurn && !currentStep ? 'location' : undefined}
                  data-directory-entry-id={turn.userEntryId}
                  ref={isCurrentTurn && !currentStep ? currentRef : null}
                  onClick={() => onNavigate(turn.userEntryId, `entry-${turn.userEntryId}`)}
                >
                  <span className="session-directory-node" aria-hidden="true" />
                  <span className="session-directory-label">第 {turn.index} 用户轮次</span>
                  {isCurrentTurn && <span className="session-directory-meta">{turnMeta}</span>}
                  <span className="session-directory-chevron" aria-hidden="true">›</span>
                </button>

                {isCurrentTurn && turn.steps.length > 0 && (
                  <div className="session-directory-steps">
                    {turn.steps.map((step) => {
                      const isCurrentStep = currentStep?.id === step.id;
                      return (
                        <div
                          key={step.id}
                          className={`session-directory-step ${isCurrentStep ? 'is-current' : ''}`}
                          ref={isCurrentStep ? currentRef : null}
                        >
                          <button
                            type="button"
                            className={`session-directory-row session-directory-step-row ${isCurrentStep ? 'is-current' : ''}`}
                            aria-current={isCurrentStep ? 'location' : undefined}
                            data-directory-step-id={step.entryId}
                            data-detail-count={step.details.length}
                            onClick={() => onNavigate(step.entryId, step.anchorId)}
                          >
                            <span className="session-directory-step-name">{stepLabel(step)}</span>
                            {stepSummary(step) && (
                              <span className="session-directory-meta">{stepSummary(step)}</span>
                            )}
                            {isCurrentStep && <span className="session-directory-current">当前</span>}
                            <span className="session-directory-chevron" aria-hidden="true">›</span>
                          </button>

                          {isCurrentStep && step.details.length > 0 && (
                            <div className="session-directory-details">
                              {step.details.map((detail) => (
                                <button
                                  key={detail.id}
                                  type="button"
                                  className={`session-directory-detail ${detail.tone || ''}`}
                                  data-directory-detail-anchor={detail.anchorId}
                                  onClick={() => onNavigate(detail.entryId, detail.anchorId)}
                                >
                                  <span>{detail.label}</span>
                                  <span className="session-directory-chevron" aria-hidden="true">›</span>
                                </button>
                              ))}
                            </div>
                          )}
                        </div>
                      );
                    })}
                  </div>
                )}
              </div>
            );
          })}
        </div>
      </div>

      <div className="session-directory-footer">
        <span>当前：{currentText}</span>
        <span>{currentTurn?.index || 1} / {turns.length} 轮</span>
      </div>
    </section>
  );
}
