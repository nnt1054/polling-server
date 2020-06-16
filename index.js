const util = require('util');
const exec = util.promisify(require('child_process').exec);
const axios = require('axios');
const semver = require('semver')
const express = require('express');
const path = require('path');
const app = express();

recent_events = []
var pipelines = [
	{
		name: "cicd_test",
		github_url: "https://github.com/nnt1054/cicd_test.git",
		events_url: "https://api.github.com/repos/nnt1054/cicd_test/events",
		registry_url: "docker-registry.com:80",
		latest_event_date: new Date(),
	}
]

var helm_pipelines = [
	{
		helm_repo_url: "http://docker-registry.com/helm-repo/api/charts",
		charts: [
			{
				name: "testchart",
				latest_version: "",
				latest_staging_date: new Date(),
			},
			{
				name: "testchart2",
				latest_version: "",
				latest_staging_date: new Date(),
			}
		]
	}
]

// pollHelmRepo
// check first entry for latest semver helm chart
// find and check the staging version
// if new semver OR new staging version:
	// send request to kubeapi to run helmsmanjob
	// update lastest_version and latest_staging
function pollHelmRepos(helm_pipelines) {
	console.log('polling...');
	var results = [];
	for (i = 0; i < helm_pipelines.length; i++) {
		pipeline = helm_pipelines[i]
		results.push(axios.get(pipeline.helm_repo_url)
			.then(response => {
				for (j = 0; j < pipeline.charts.length; j++) {
					chart = pipeline.charts[j];
					if (!(chart.name in response.data)) {
						continue
					}
					latest = response.data[chart.name][0];
					if (chart.latest_version == "") {
						chart.latest_version = latest.version
					}
					if (semver.gt(latest.version, chart.latest_version)) {
						// call helm-api
						axios.get("http://10.109.248.87/test")
							.then(response => console.log(response))
							.catch(e => console.log(e))
						console.log("found new version");
						console.log(latest.version);
						chart.latest_version = semver.clean(latest.version);
					}
					for (k = response.data[chart.name].length - 1; k >= 0; k--) {
						staging = response.data[chart.name][k];
						if (staging.version == 'staging') {
							var staging_date = new Date(staging.created)
							if (staging_date > chart.latest_staging_date) {
								// call helm-api
								axios.get("http://10.109.248.87/test")
									.then(response => console.log(response))
									.catch(e => console.log(e))
								console.log("found new staging");
								console.log(chart.latest_staging_date);
								chart.latest_staging_date = staging_date;
							}
							break;
						}
					}
				}
				return 1;
			})
			.catch(e => {
				console.log(e);
				return 0;
			})
		)
	}
	Promise.all(results)
		.then(values => {
			console.log(values)
			setTimeout(() =>  { pollHelmRepos(helm_pipelines) }, 1 * 60 * 1000);
		})
		.catch(e => {
			console.log(e)
			setTimeout(() =>  { pollHelmRepos(helm_pipelines) }, 1 * 60 * 1000);
		})
}





// STARTUP
function pollPipelines(pipelines) {
	// loop through pipelines and send requests to Github Events API
	var results = [];
	for (i = 0; i < pipelines.length; i++) {
		pipeline = pipelines[i];
		results.push(
			axios.get(pipeline.events_url)
			.then(response => processEvents(pipeline, response.data))
			.then(() => {
				pipeline.latest_event_date = new Date();
				return 1
			})
			.catch(e => {
				console.log(e)
				return 0
			})
		);
	}
	Promise.all(results)
		.then(values => {
			console.log(values)
			setTimeout(() =>  { pollPipelines(pipelines) }, 1 * 60 * 1000);
		})
		.catch(e => {
			console.log(e)
			setTimeout(() =>  { pollPipelines(pipelines) }, 1 * 60 * 1000);
		})
	// return Promise.all(results);
}

async function processEvents(pipeline, events) {
	// Loop through and call startPipeline on any new events
	var results = [];
	for (i = 0; i < events.length; i++) {
		// first events are the most recent
		var event = events[i];
		var event_date = new Date(event.created_at)
		if (event_date > pipeline.latest_event_date) {
			results.push(startPipeline(pipeline, event));
		}
	}
	return Promise.all(results);
}

async function startPipeline(pipeline, event) {
	// if new PushEvent then build with staging tag
	// if new CreateEvent with:
	// 		ref_type: tag
	// 		ref: v0.0.0
	// 			need to verify SemVer tag before preceding
	var tag;
	switch(event.type) {
		case 'PushEvent':
			tag = 'staging';
			break;
		case 'CreateEvent':
			if (event.payload.ref_type == 'tag' && semver.valid(event.payload.ref)) {
				tag = semver.clean(event.payload.ref);
			} else {
				tag = event.payload.ref + '-rc';
			}
			break;
		default:
			tag = 'dev';
			// Exit without taking actions
			return Promise.resolve();
	}
	var imageTag = `${pipeline.registry_url}/${pipeline.name}:${tag}`
	console.log('IMAGE_TAG: ' + imageTag);

	var event_result = {
		imageTag: imageTag
	}

	let result = await dockerBuildAndTag(pipeline, imageTag, event_result)
		.then(() => dockerPush(pipeline, imageTag, event_result))
		.then(() => console.log('Pipeline Finished Running'))
		.catch(e => {
			console.log('Error: ' + e)
			event_result.error = e;
		})

	recent_events.unshift(event_result);

	return result
}

async function dockerBuildAndTag(pipeline, imageTag, event_result) {
	var dockerBuildString =
		`docker build -t ${imageTag} ${pipeline.github_url}`;

	let result = await exec(dockerBuildString)
	.then((result) => {
		console.log(result.stdout);
		if (result.stderr) {
			console.log(`STDERR: ${result.stderr}`)
		}
		event_result.buildSuccessful = true;
	})
	.catch((e) => {
		console.log("Docker Build Failed!")
		event_result.buildSuccessful = false;
	});

	return result
}

async function dockerPush(pipeline, imageTag, event_result) {
	var dockerPushString = `docker push ${imageTag}`;

	let result = exec(dockerPushString)
		.then((result) => {
			console.log(result.stdout);
			if (result.stderr) {
				console.log(`STDERR: ${result.stderr}`)
			}
			event_result.pushSuccessful = true;
		})
		.catch((e) => {
			console.log("Docker Push Failed!")
			event_result.pushSuccessful = false;
		});
	return result
}

// ROUTES
app.get('/events', function(req, res) {
	res.json(recent_events);
})

app.get('/', function(req, res) {
	res.send('pepega')
})

app.get('/polling-server', function(req, res) {
	res.send('monkaS')
})

// setTimeout(() => { pollPipelines(pipelines) }, 1 * 60 * 1000);
// pollPipelines(pipelines);
// setTimeout(() => { pollHelmRepos(helm_pipelines) }, 1 * 60 * 1000);
pollHelmRepos(helm_pipelines)
// const port = process.env.PORT || 8000;
const port = 80;
app.listen(port);

console.log('App is listening on port ' + port);