import { STORY_DESCRIPTIVE_NOTE, STRUCTURE_READ_TITLE } from '../../engine/smc/chartStory'

/** Title first, then the limit. Same weight as the old Conf badge. */
export function DescriptiveNote() {
  return (
    <p className="rounded-md border border-amber-300/70 bg-amber-400/20 px-2.5 py-1.5 font-mono leading-snug text-amber-50">
      <span className="block text-[13px] font-bold uppercase tracking-wide">
        {STRUCTURE_READ_TITLE}
      </span>
      <span className="mt-0.5 block text-[12px] font-bold">{STORY_DESCRIPTIVE_NOTE}</span>
    </p>
  )
}
