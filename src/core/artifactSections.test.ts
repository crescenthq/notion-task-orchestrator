import {describe, expect, it} from 'vitest'
import {readSection, removeSection, writeSection} from './artifactSections'

describe('artifactSections', () => {
  describe('readSection', () => {
    it('returns content for an existing section', () => {
      const markdown = [
        '# Task',
        '',
        '## Plan',
        '- outline work',
        '- validate approach',
        '',
        '## Notes',
        'Keep this section intact',
      ].join('\n')

      expect(readSection(markdown, 'Plan')).toBe(
        '- outline work\n- validate approach',
      )
    })

    it('returns null when the section is missing', () => {
      expect(readSection('## Plan\nBuild slice', 'Notes')).toBeNull()
    })

    it('returns an empty string for an empty section body', () => {
      const markdown = ['## Plan', '', '## Notes', 'Keep this section'].join('\n')

      expect(readSection(markdown, 'Plan')).toBe('')
    })
  })

  describe('writeSection', () => {
    it('replaces content for an existing section without changing others', () => {
      const markdown = [
        '# Task',
        '',
        '## Plan',
        'Old plan',
        '',
        '## Notes',
        'Keep this section',
        '',
        '## Risks',
        'Track this too',
      ].join('\n')

      expect(writeSection(markdown, 'Notes', 'Updated notes')).toBe(
        [
          '# Task',
          '',
          '## Plan',
          'Old plan',
          '',
          '## Notes',
          'Updated notes',
          '',
          '## Risks',
          'Track this too',
        ].join('\n'),
      )
    })

    it('appends a missing section at the end of the artifact', () => {
      const markdown = ['# Task', '', '## Plan', 'Build slice first'].join('\n')

      expect(writeSection(markdown, 'Notes', 'Captured feedback')).toBe(
        [
          '# Task',
          '',
          '## Plan',
          'Build slice first',
          '',
          '## Notes',
          'Captured feedback',
        ].join('\n'),
      )
    })

    it('supports writing an empty section body', () => {
      expect(writeSection('## Plan\nBuild slice first', 'Plan', '')).toBe(
        '## Plan',
      )
    })
  })

  describe('removeSection', () => {
    it('removes a section from the middle of multiple sections', () => {
      const markdown = [
        '# Task',
        '',
        '## Plan',
        'Build slice first',
        '',
        '## Notes',
        'Captured feedback',
        '',
        '## Risks',
        'Track this too',
      ].join('\n')

      expect(removeSection(markdown, 'Notes')).toBe(
        [
          '# Task',
          '',
          '## Plan',
          'Build slice first',
          '',
          '## Risks',
          'Track this too',
        ].join('\n'),
      )
    })

    it('returns the original artifact when the section is missing', () => {
      const markdown = '## Plan\nBuild slice first'

      expect(removeSection(markdown, 'Notes')).toBe(markdown)
    })

    it('removes an empty section cleanly', () => {
      const markdown = ['## Plan', '', '## Notes', 'Captured feedback'].join('\n')

      expect(removeSection(markdown, 'Plan')).toBe('## Notes\nCaptured feedback')
    })
  })
})
