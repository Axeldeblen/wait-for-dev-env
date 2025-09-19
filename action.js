// @ts-check
// Dependencies are compiled using https://github.com/vercel/ncc
const core = require('@actions/core');
const github = require('@actions/github');
const axios = require('axios');

const calculateIterations = (maxTimeoutSec, checkIntervalInMilliseconds) =>
  Math.floor(maxTimeoutSec / (checkIntervalInMilliseconds / 1000));

const wait = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

const waitForStatus = async ({
  token,
  owner,
  repo,
  deployment_id,
  maxTimeout,
  allowInactive,
  checkIntervalInMilliseconds,
}) => {
  const octokit = new github.getOctokit(token);
  const iterations = calculateIterations(
    maxTimeout,
    checkIntervalInMilliseconds
  );

  for (let i = 0; i < iterations; i++) {
    try {
      const statuses = await octokit.rest.repos.listDeploymentStatuses({
        owner,
        repo,
        deployment_id,
      });

      const status = statuses.data.length > 0 && statuses.data[0];
      console.log({ status });

      if (!status) {
        throw new StatusError('No status was available');
      }

      if (status && allowInactive === true && status.state === 'inactive') {
        return status;
      }

      if (status && status.state !== 'success') {
        throw new StatusError('No status with state "success" was available');
      }

      if (status && status.state === 'success') {
        return status;
      }

      throw new StatusError('Unknown status error');
    } catch (e) {
      console.log(
        `Deployment unavailable or not successful, retrying (attempt ${
          i + 1
        } / ${iterations})`
      );
      if (e instanceof StatusError) {
        if (e.message.includes('No status with state "success"')) {
          // TODO: does anything actually need to be logged in this case?
        } else {
          console.log(e.message);
        }
      } else {
        console.log(e);
      }
      await wait(checkIntervalInMilliseconds);
    }
  }
  core.setFailed(
    `Timeout reached: Unable to wait for an deployment to be successful`
  );
};

class StatusError extends Error {
  constructor(message) {
    super(message);
  }
}

/**
 * Waits until the github API returns a deployment for
 * a given actor.
 *
 * Accounts for race conditions where this action starts
 * before the actor's action has started.
 *
 * @returns
 */
const waitForDeploymentToStart = async ({
  octokit,
  owner,
  repo,
  sha,
  environment,
  actorName,
  maxTimeout = 20,
  checkIntervalInMilliseconds = 2000,
}) => {
  const iterations = calculateIterations(
    maxTimeout,
    checkIntervalInMilliseconds
  );

  for (let i = 0; i < iterations; i++) {
    try {
      const deployments = await octokit.rest.repos.listDeployments({
        owner,
        repo,
        sha,
        environment,
      });

      const deployment =
        deployments.data.length > 0 &&
        deployments.data.find((deployment) => {
          return deployment.creator.login === actorName;
        });

      if (deployment) {
        console.log({ deployment });
        return deployment;
      }

      console.log(
        `Could not find any deployments for actor ${actorName}, retrying (attempt ${
          i + 1
        } / ${iterations})`
      );
    } catch (e) {
      console.log(
        `Error while fetching deployments, retrying (attempt ${
          i + 1
        } / ${iterations})`
      );

      console.error(e);
    }

    await wait(checkIntervalInMilliseconds);
  }

  return null;
};

async function getShaForPullRequest({ octokit, owner, repo, number }) {
  const PR_NUMBER = github.context.payload.pull_request.number;

  if (!PR_NUMBER) {
    core.setFailed('No pull request number was found');
    return;
  }

  // Get information about the pull request
  const currentPR = await octokit.rest.pulls.get({
    owner,
    repo,
    pull_number: PR_NUMBER,
  });

  if (currentPR.status !== 200) {
    core.setFailed('Could not get information about the current pull request');
    return;
  }

  // Get Ref from pull request
  const prSHA = currentPR.data.head.sha;

  return prSHA;
}

const run = async () => {
  try {
    // Inputs
    const GITHUB_TOKEN = core.getInput('token', { required: true });
    const ENVIRONMENT = core.getInput('environment');
    const ACTOR_NAME = core.getInput('actor_name');
    const MAX_TIMEOUT = Number(core.getInput('max_timeout')) || 60;
    const ALLOW_INACTIVE = Boolean(core.getInput('allow_inactive')) || false;
    const PATH = core.getInput('path') || '/';
    const CHECK_INTERVAL_IN_MS =
      (Number(core.getInput('check_interval')) || 2) * 1000;

    // Fail if we have don't have a github token
    if (!GITHUB_TOKEN) {
      core.setFailed('Required field `token` was not provided');
    }

    const octokit = github.getOctokit(GITHUB_TOKEN);

    const context = github.context;
    const owner = context.repo.owner;
    const repo = context.repo.repo;

    /**
     * @type {string}
     */
    let sha;

    if (github.context.payload && github.context.payload.pull_request) {
      sha = await getShaForPullRequest({
        octokit,
        owner,
        repo,
        number: github.context.payload.pull_request.number,
      });
    } else if (github.context.sha) {
      sha = github.context.sha;
    }

    if (!sha) {
      core.setFailed('Unable to determine SHA. Exiting...');
      return;
    }

    // Get deployments associated with the pull request.
    const deployment = await waitForDeploymentToStart({
      octokit,
      owner,
      repo,
      sha: sha,
      environment: ENVIRONMENT,
      actorName: ACTOR_NAME,
      maxTimeout: MAX_TIMEOUT,
      checkIntervalInMilliseconds: CHECK_INTERVAL_IN_MS,
    });

    if (!deployment) {
      core.setFailed('no deployment found, exiting...');
      return;
    }

    const status = await waitForStatus({
      owner,
      repo,
      deployment_id: deployment.id,
      token: GITHUB_TOKEN,
      maxTimeout: MAX_TIMEOUT,
      allowInactive: ALLOW_INACTIVE,
      checkIntervalInMilliseconds: CHECK_INTERVAL_IN_MS,
    });

    // Get target url
    const targetUrl = status.environment_url;
    const targetHost = new URL(targetUrl).host;

    if (!targetUrl) {
      core.setFailed(`no target_url found in the status check`);
      return;
    }

    console.log('target url »', targetUrl);
    console.log('target host »', targetHost);

    // Set output
    core.setOutput('url', targetUrl);
    core.setOutput('host', targetHost);
  } catch (error) {
    core.setFailed(error.message);
  }
};

exports.run = run;
