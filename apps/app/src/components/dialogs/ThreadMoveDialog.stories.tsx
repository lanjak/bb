import {
  ThreadMoveDialogContent,
  type ThreadMoveTargetOption,
} from "./ThreadMoveDialog";
import { StoryCard, StoryRow } from "../../../.ladle/story-card";
import { DialogStage } from "../../../.ladle/story-dialog-stage";

export default {
  title: "dialogs/Thread Move",
};

const noop = () => {};

const options: ThreadMoveTargetOption[] = [
  {
    environmentId: "env_studio",
    machineName: "Mac Studio",
    path: "/Users/me/bb/checkouts/bb",
    branchName: "main",
  },
  {
    environmentId: "env_srv",
    machineName: "lanjak-srv",
    path: "/home/me/worktrees/very/long/path/to/the/feature/checkout/for/this/thread",
    branchName: "feature/thread-move",
  },
];

function Stage(props: {
  label: string;
  hint: string;
  options?: ThreadMoveTargetOption[];
  loading?: boolean;
  pending?: boolean;
  error?: string | null;
}) {
  return (
    <StoryRow label={props.label} hint={props.hint}>
      <DialogStage>
        <ThreadMoveDialogContent
          options={props.options ?? options}
          loading={props.loading ?? false}
          pending={props.pending ?? false}
          error={props.error ?? null}
          onMove={noop}
          onCancel={noop}
        />
      </DialogStage>
    </StoryRow>
  );
}

export function Move() {
  return (
    <StoryCard>
      <Stage label="choices" hint="ready environments on other machines" />
      <Stage label="loading" hint="environments still loading" loading />
      <Stage
        label="empty"
        hint="no other machine has an environment"
        options={[]}
      />
      <Stage label="pending" hint="move request in flight" pending />
      <Stage
        label="refused"
        hint="server message shown verbatim"
        error="Thread thr_abc is not idle."
      />
    </StoryCard>
  );
}
