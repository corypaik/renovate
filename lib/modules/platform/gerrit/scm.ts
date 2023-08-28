import { randomUUID } from 'crypto';
import { logger } from '../../../logger';
import * as git from '../../../util/git';
import type { CommitFilesConfig, CommitSha } from '../../../util/git/types';
import { hash } from '../../../util/hash';
import { DefaultGitScm } from '../default-scm';
import { client } from './client';
import type { GerritFindPRConfig } from './types';

// TODO(corypaik): How to get gitIgonredAuthors from config??
const gitIgonredAuthors = [
  'bazel-worker@corypaik.com',
];

let repository: string;
let username: string;
export function configureScm(repo: string, login: string): void {
  repository = repo;
  username = login;
}

export class GerritScm extends DefaultGitScm {
  override async branchExists(branchName: string): Promise<boolean> {
    const searchConfig: GerritFindPRConfig = { state: 'open', branchName };
    const change = await client
      .findChanges(repository, searchConfig, true)
      .then((res) => res.pop());
    if (change) {
      return true;
    }
    return git.branchExists(branchName);
  }

  override async getBranchCommit(
    branchName: string
  ): Promise<CommitSha | null> {
    const searchConfig: GerritFindPRConfig = { state: 'open', branchName };
    const change = await client
      .findChanges(repository, searchConfig, true)
      .then((res) => res.pop());
    if (change) {
      return change.current_revision!;
    }
    return git.getBranchCommit(branchName);
  }

  override async isBranchBehindBase(
    branchName: string,
    baseBranch: string
  ): Promise<boolean> {
    const searchConfig: GerritFindPRConfig = {
      state: 'open',
      branchName,
      targetBranch: baseBranch,
    };
    const change = await client
      .findChanges(repository, searchConfig, true)
      .then((res) => res.pop());
    if (change) {
      const currentGerritPatchset = change.revisions![change.current_revision!];
      return currentGerritPatchset.actions?.['rebase'].enabled === true;
    }
    return true;
  }

  override async isBranchConflicted(
    baseBranch: string,
    branch: string
  ): Promise<boolean> {
    const searchConfig: GerritFindPRConfig = {
      state: 'open',
      branchName: branch,
      targetBranch: baseBranch,
    };
    const change = (await client.findChanges(repository, searchConfig)).pop();
    if (change) {
      const mergeInfo = await client.getMergeableInfo(change);
      return !mergeInfo.mergeable;
    } else {
      logger.warn(
        `There is no open change with branch=${branch} and baseBranch=${baseBranch}`
      );
      return true;
    }
  }

  override async isBranchModified(branchName: string): Promise<boolean> {
    const searchConfig: GerritFindPRConfig = { state: 'open', branchName };
    const change = await client
      .findChanges(repository, searchConfig, true)
      .then((res) => res.pop());
    if (!change) {
      return false;
    }

    const currentGerritPatchset = change.revisions![change.current_revision!];

    const lastAuthor = currentGerritPatchset.commit.committer.email;

    // From //lib/util/git/index.ts:isBranchModified
    if (
      currentGerritPatchset.uploader.username === username ||
      // lastAuthor === gitAuthorEmail ||
      gitIgonredAuthors.some((ignoredAuthor) => lastAuthor === ignoredAuthor)
    ) {
      // author matches - branch has not been modified
      logger.debug('branch.isModified() = false');
      return false;
    }
    logger.debug(
      { branchName, lastAuthor, username },
      'branch.isModified() = true'
    );
    return true;
  }

  override async commitAndPush(
    commit: CommitFilesConfig
  ): Promise<CommitSha | null> {
    logger.debug(`commitAndPush(${commit.branchName})`);
    const searchConfig: GerritFindPRConfig = {
      state: 'open',
      branchName: commit.branchName,
      targetBranch: commit.baseBranch,
    };
    const existingChange = await client
      .findChanges(repository, searchConfig, true)
      .then((res) => res.pop());

    let hasChanges = true;
    const origMsg =
      typeof commit.message === 'string' ? [commit.message] : commit.message;
    commit.message = [
      ...origMsg,
      `Change-Id: ${existingChange?.change_id ?? generateChangeId()}`,
    ];
    const commitResult = await git.prepareCommit({ ...commit, force: true });
    if (commitResult) {
      const { commitSha } = commitResult;
      if (existingChange?.revisions && existingChange.current_revision) {
        const fetchRefSpec =
          existingChange.revisions[existingChange.current_revision].ref;
        await git.fetchRevSpec(fetchRefSpec); //fetch current ChangeSet for git diff
        hasChanges = await git.hasDiff('HEAD', 'FETCH_HEAD'); //avoid empty patchsets
      }
      if (hasChanges || commit.force) {
        const pushResult = await git.pushCommit({
          sourceRef: commit.branchName,
          targetRef: `refs/for/${commit.baseBranch!}%t=sourceBranch-${
            commit.branchName
          }`,
          files: commit.files,
        });
        if (pushResult) {
          //existingChange was the old change before commit/push. we need to approve again, if it was previously approved from renovate
          if (
            existingChange &&
            client.wasApprovedBy(existingChange, username)
          ) {
            await client.approveChange(existingChange._number);
          }
          return commitSha;
        }
      }
    }
    return null; //empty commit, no changes in this Gerrit-Change
  }

  override deleteBranch(branchName: string): Promise<void> {
    return Promise.resolve();
  }

  override async mergeToLocal(branchName: string): Promise<void> {
    const searchConfig: GerritFindPRConfig = { state: 'open', branchName };
    const change = await client
      .findChanges(repository, searchConfig, true)
      .then((res) => res.pop());
    if (change) {
      return super.mergeToLocal(
        change.revisions![change.current_revision!].ref
      );
    }
    return super.mergeToLocal(branchName);
  }
}

/**
 * This function should generate a Gerrit Change-ID analogous to the commit hook. We avoid the commit hook cause of security concerns.
 * random=$( (whoami ; hostname ; date; cat $1 ; echo $RANDOM) | git hash-object --stdin) prefixed with an 'I'.
 * TODO: Gerrit don't accept longer Change-IDs (sha256), but what happens with this https://git-scm.com/docs/hash-function-transition/ ?
 */
function generateChangeId(): string {
  return 'I' + hash(randomUUID(), 'sha1');
}
