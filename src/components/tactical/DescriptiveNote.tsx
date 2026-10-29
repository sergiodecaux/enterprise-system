import { STORY_DESCRIPTIVE_NOTE, STRUCTURE_READ_TITLE } from '../../engine/smc/chartStory'

/** Calm caveat under a scenario — a note, not an alert banner. */
export function DescriptiveNote() {
  return (
    <div className="rounded-sm border-l-2 border-market-warning/50 bg-market-warning/[0.05] py-1 pl-2.5 pr-2">
      <span className="block font-sans text-[11px] font-medium leading-4 text-market-warning/90">
        {STRUCTURE_READ_TITLE}
      </span>
      <span className="mt-0.5 block font-sans text-[11px] leading-4 text-text-muted">
        {STORY_DESCRIPTIVE_NOTE}
      </span>
    </div>
  )
}
